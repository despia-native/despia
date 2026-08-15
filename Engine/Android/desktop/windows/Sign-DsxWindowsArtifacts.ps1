# Signs a complete DSX-framework Windows application image before packaging, builds MSI
# and EXE installers from that signed image, then signs the outer containers.
# Vendor-signed JDK binaries are preserved; every unsigned PE is signed by the release publisher.

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string] $AppImage,

    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string] $OutputDirectory,

    [Parameter(Mandatory = $true)]
    [ValidatePattern('^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$')]
    [string] $ExpectedVersion,

    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[A-Za-z0-9][A-Za-z0-9.-]{1,127}$')]
    [string] $ExpectedAppId,

    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$')]
    [string] $ExpectedAppTitle,

    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$')]
    [string] $ExpectedBuild,

    [AllowEmptyString()]
    [string] $ExpectedEntry = '',

    [AllowEmptyString()]
    [string] $ExpectedAssets = '',

    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[0-9A-Fa-f]{40}$')]
    [string] $ExpectedPublisherThumbprint,

    [Parameter(Mandatory = $true)]
    [ValidatePattern('^https://')]
    [string] $TimestampUrl,

    [Parameter(Mandatory = $true)]
    [string] $ManifestOutput,

    [Parameter(Mandatory = $true)]
    [string] $PayloadManifestOutput
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
. "$PSScriptRoot\Get-DsxWindowsPackageEvidence.ps1"

if ($ExpectedAppTitle.EndsWith('.') -or
    $ExpectedAppTitle -match '^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\..*)?$') {
    throw 'ExpectedAppTitle is not a portable Windows product/launcher name.'
}

if (-not $IsWindows) {
    throw 'Windows application signing must run on Windows.'
}

$versionParts = @($ExpectedVersion.Split('.') | ForEach-Object { [uint32] $_ })
if ($versionParts[0] -gt 255 -or $versionParts[1] -gt 255 -or $versionParts[2] -gt 65535) {
    throw "MSI version requires major/minor <= 255 and build <= 65535: $ExpectedVersion"
}
$canonicalAppId = $ExpectedAppId.ToLowerInvariant()
$launcherName = "$ExpectedAppTitle.exe"

function Assert-OptionalRepositoryPath {
    param(
        [Parameter(Mandatory = $true)] [string] $Name,
        [AllowEmptyString()] [string] $Value,
        [switch] $RequireDsxFile
    )

    if ([string]::IsNullOrEmpty($Value)) { return }
    if ($Value.Length -gt 512 -or $Value.Contains('\') -or [System.IO.Path]::IsPathRooted($Value) -or
        $Value -notmatch '^[A-Za-z0-9][A-Za-z0-9._/ -]*$') {
        throw "$Name must be a canonical repository-relative path."
    }
    $segments = @($Value.Split('/'))
    $unsafeSegments = @($segments | Where-Object { $_ -eq '' -or $_ -eq '.' -or $_ -eq '..' })
    if ($segments.Count -eq 0 -or $unsafeSegments.Count -gt 0) {
        throw "$Name contains an empty or traversing path segment."
    }
    if ($RequireDsxFile -and -not $Value.EndsWith('.dsx', [StringComparison]::OrdinalIgnoreCase)) {
        throw "$Name must identify a .dsx file."
    }
}

Assert-OptionalRepositoryPath -Name 'ExpectedEntry' -Value $ExpectedEntry -RequireDsxFile
Assert-OptionalRepositoryPath -Name 'ExpectedAssets' -Value $ExpectedAssets

function Get-DesktopUpgradeUuid {
    param([Parameter(Mandatory = $true)] [string] $CanonicalAppId)

    $nameBytes = [System.Text.Encoding]::UTF8.GetBytes("dev.dsx.desktop:$CanonicalAppId")
    $md5 = [System.Security.Cryptography.MD5]::Create()
    try {
        $uuidBytes = $md5.ComputeHash($nameBytes)
    }
    finally {
        $md5.Dispose()
        [Array]::Clear($nameBytes, 0, $nameBytes.Length)
    }
    $uuidBytes[6] = [byte] (($uuidBytes[6] -band 0x0f) -bor 0x30)
    $uuidBytes[8] = [byte] (($uuidBytes[8] -band 0x3f) -bor 0x80)
    $hex = [Convert]::ToHexString($uuidBytes).ToLowerInvariant()
    [Array]::Clear($uuidBytes, 0, $uuidBytes.Length)
    return '{0}-{1}-{2}-{3}-{4}' -f `
        $hex.Substring(0, 8), $hex.Substring(8, 4), $hex.Substring(12, 4), `
        $hex.Substring(16, 4), $hex.Substring(20, 12)
}

$upgradeUuid = Get-DesktopUpgradeUuid -CanonicalAppId $canonicalAppId

function Get-DsxPeMachineOrNull {
    param([Parameter(Mandatory = $true)] [System.IO.FileInfo] $File)

    $stream = [System.IO.File]::Open(
        $File.FullName,
        [System.IO.FileMode]::Open,
        [System.IO.FileAccess]::Read,
        [System.IO.FileShare]::Read
    )
    try {
        if ($stream.Length -lt 0x40) { return $null }
        $reader = [System.IO.BinaryReader]::new($stream)
        try {
            if ($reader.ReadUInt16() -ne 0x5a4d) { return $null }
            [void] $stream.Seek(0x3c, [System.IO.SeekOrigin]::Begin)
            $peOffset = $reader.ReadUInt32()
            if ($peOffset -lt 0x40 -or $peOffset -gt ($stream.Length - 24)) {
                throw "Native payload has an invalid PE offset: $($File.FullName)"
            }
            [void] $stream.Seek($peOffset, [System.IO.SeekOrigin]::Begin)
            if ($reader.ReadUInt32() -ne 0x00004550) {
                throw "Native payload has an invalid PE signature: $($File.FullName)"
            }
            return $reader.ReadUInt16()
        }
        finally {
            $reader.Dispose()
        }
    }
    finally {
        $stream.Dispose()
    }
}

function Get-NormalizedThumbprint {
    param([Parameter(Mandatory = $true)] [string] $Value)
    return $Value.Replace(' ', '').ToUpperInvariant()
}

function Get-ValidatedSignature {
    param(
        [Parameter(Mandatory = $true)] [System.IO.FileInfo] $File,
        [string] $RequiredThumbprint
    )

    $signature = Get-AuthenticodeSignature -LiteralPath $File.FullName
    if ($signature.Status -ne [System.Management.Automation.SignatureStatus]::Valid -or
        $null -eq $signature.SignerCertificate) {
        throw "$($File.FullName) has invalid Authenticode status $($signature.Status)"
    }
    if ($null -eq $signature.TimeStamperCertificate) {
        throw "$($File.FullName) has no RFC 3161 timestamp"
    }
    if (-not [string]::IsNullOrWhiteSpace($RequiredThumbprint)) {
        $actual = Get-NormalizedThumbprint $signature.SignerCertificate.Thumbprint
        if ($actual -cne (Get-NormalizedThumbprint $RequiredThumbprint)) {
            throw "$($File.FullName) signer thumbprint mismatch: $actual"
        }
    }
    return $signature
}

function Invoke-AuthenticodeSign {
    param(
        [Parameter(Mandatory = $true)] [string] $SignTool,
        [Parameter(Mandatory = $true)] [System.IO.FileInfo] $File,
        [Parameter(Mandatory = $true)] [string] $Thumbprint
    )

    $arguments = @(
        'sign', '/sha1', $Thumbprint, '/s', 'My',
        '/fd', 'SHA256', '/td', 'SHA256', '/tr', $TimestampUrl,
        '/v', $File.FullName
    )
    $lastExit = -1
    foreach ($attempt in 1..3) {
        & $SignTool @arguments
        $lastExit = $LASTEXITCODE
        if ($lastExit -eq 0) { break }
        if ($attempt -lt 3) { Start-Sleep -Seconds 2 }
    }
    if ($lastExit -ne 0) {
        throw "signtool failed for $($File.FullName) with exit code $lastExit"
    }
    [void] (Get-ValidatedSignature -File $File -RequiredThumbprint $Thumbprint)
}

function Resolve-SignTool {
    $command = Get-Command 'signtool.exe' -ErrorAction SilentlyContinue
    if ($null -ne $command) { return $command.Source }

    $sdkRoot = "${env:ProgramFiles(x86)}\Windows Kits\10\bin"
    $candidate = Get-ChildItem -LiteralPath $sdkRoot -Recurse -File -Filter 'signtool.exe' |
        Where-Object { $_.FullName -match '\\x64\\signtool\.exe$' } |
        Sort-Object FullName -Descending |
        Select-Object -First 1
    if ($null -eq $candidate) { throw 'signtool.exe is unavailable.' }
    return $candidate.FullName
}

function Resolve-Jpackage {
    $fromJavaHome = if ([string]::IsNullOrWhiteSpace($env:JAVA_HOME)) {
        $null
    }
    else {
        Join-Path $env:JAVA_HOME 'bin\jpackage.exe'
    }
    if ($null -ne $fromJavaHome -and (Test-Path -LiteralPath $fromJavaHome -PathType Leaf)) {
        return (Get-Item -LiteralPath $fromJavaHome).FullName
    }
    $command = Get-Command 'jpackage.exe' -ErrorAction SilentlyContinue
    if ($null -eq $command) { throw 'jpackage.exe is unavailable.' }
    return $command.Source
}

function Invoke-JpackageInstaller {
    param(
        [Parameter(Mandatory = $true)] [string] $Jpackage,
        [Parameter(Mandatory = $true)] [ValidateSet('msi', 'exe')] [string] $Type,
        [Parameter(Mandatory = $true)] [string] $Image,
        [Parameter(Mandatory = $true)] [string] $Destination
    )

    $arguments = @(
        '--type', $Type,
        '--app-image', $Image,
        '--dest', $Destination,
        '--name', $ExpectedAppTitle,
        '--app-version', $ExpectedVersion,
        '--vendor', 'DSX',
        '--description', "$ExpectedAppTitle native desktop runtime",
        '--copyright', 'Copyright DSX',
        '--win-per-user-install',
        '--win-menu',
        '--win-menu-group', 'DSX',
        '--win-shortcut',
        # Must equal UUID.nameUUIDFromBytes("dev.dsx.desktop:<canonical-app-id>")
        # in desktop/build.gradle.kts. A signed installer may never silently switch
        # upgrade families from the unsigned candidate it replaces.
        '--win-upgrade-uuid', $upgradeUuid
    )
    & $Jpackage @arguments
    if ($LASTEXITCODE -ne 0) {
        throw "jpackage --type $Type failed with exit code $LASTEXITCODE"
    }
}

function Write-PayloadManifest {
    param(
        [Parameter(Mandatory = $true)] [System.IO.DirectoryInfo] $Root,
        [Parameter(Mandatory = $true)] [System.IO.FileInfo[]] $NativeFiles,
        [Parameter(Mandatory = $true)] [object] $PackageEvidence,
        [Parameter(Mandatory = $true)] [string] $Destination
    )

    $nativeByPath = @{}
    foreach ($native in $NativeFiles) {
        $signature = Get-ValidatedSignature -File $native
        $nativeByPath[$native.FullName.ToUpperInvariant()] = [ordered]@{
            signatureStatus = $signature.Status.ToString()
            signerSubject = $signature.SignerCertificate.Subject
            signerThumbprint = $signature.SignerCertificate.Thumbprint.ToLowerInvariant()
            timestamped = $true
        }
    }

    $records = @(Get-ChildItem -LiteralPath $Root.FullName -Recurse -Force -File |
        ForEach-Object {
            $relative = [System.IO.Path]::GetRelativePath($Root.FullName, $_.FullName).Replace('\\', '/')
            $nativeRecord = $nativeByPath[$_.FullName.ToUpperInvariant()]
            [ordered]@{
                path = $relative
                bytes = $_.Length
                sha256 = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
                authenticode = $nativeRecord
            }
        } |
        Sort-Object { $_.path })

    $manifest = [ordered]@{
        schema = 'dev.dsx.windows-payload/v2'
        packageEvidence = $PackageEvidence
        files = $records
    }
    $json = $manifest | ConvertTo-Json -Depth 8
    $manifestPath = [System.IO.Path]::GetFullPath($Destination)
    $parent = [System.IO.Path]::GetDirectoryName($manifestPath)
    [System.IO.Directory]::CreateDirectory($parent) | Out-Null
    [System.IO.File]::WriteAllText($manifestPath, "$json`n", [System.Text.UTF8Encoding]::new($false))
}

$image = Get-Item -LiteralPath $AppImage -Force
if (-not $image.PSIsContainer -or $image.LinkType) {
    throw "AppImage must be a real directory: $AppImage"
}
$reparsePoints = @(Get-ChildItem -LiteralPath $image.FullName -Recurse -Force |
    Where-Object { ($_.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0 })
if ($reparsePoints.Count -gt 0) {
    throw "AppImage contains reparse points: $($reparsePoints[0].FullName)"
}
$launchers = @(Get-ChildItem -LiteralPath $image.FullName -Recurse -Force -File -Filter $launcherName)
if ($launchers.Count -ne 1) {
    throw "AppImage must contain exactly one $launcherName; found $($launchers.Count)"
}
$packageEvidence = Get-DsxWindowsPackageEvidence `
    -ApplicationRoot $image.FullName `
    -Launcher $launchers[0].FullName `
    -ExpectedVersion $ExpectedVersion `
    -ExpectedAppId $canonicalAppId `
    -ExpectedAppTitle $ExpectedAppTitle `
    -ExpectedBuild $ExpectedBuild `
    -ExpectedEntry $ExpectedEntry `
    -ExpectedAssets $ExpectedAssets

$output = [System.IO.DirectoryInfo]::new([System.IO.Path]::GetFullPath($OutputDirectory))
[System.IO.Directory]::CreateDirectory($output.FullName) | Out-Null
if (@(Get-ChildItem -LiteralPath $output.FullName -Force).Count -ne 0) {
    throw "Signed package output directory must be empty: $($output.FullName)"
}

$pfxBase64 = $env:DSX_WINDOWS_SIGNING_PFX_BASE64
$pfxPasswordText = $env:DSX_WINDOWS_SIGNING_PFX_PASSWORD
$env:DSX_WINDOWS_SIGNING_PFX_BASE64 = $null
$env:DSX_WINDOWS_SIGNING_PFX_PASSWORD = $null
if ([string]::IsNullOrWhiteSpace($pfxBase64) -or [string]::IsNullOrWhiteSpace($pfxPasswordText)) {
    throw 'Windows signing credentials are absent.'
}
if ($pfxBase64.Length -gt (4 * 1024 * 1024)) {
    throw 'Windows signing PFX secret exceeds the 4 MiB encoded limit.'
}

$expected = Get-NormalizedThumbprint $ExpectedPublisherThumbprint
$existingCertificates = @(Get-ChildItem -LiteralPath 'Cert:\CurrentUser\My')
$existingThumbprints = @($existingCertificates | ForEach-Object {
    Get-NormalizedThumbprint $_.Thumbprint
})
if ($expected -in $existingThumbprints) {
    throw "Expected signing identity already exists in CurrentUser\\My: $expected"
}

$pfxPath = Join-Path $env:RUNNER_TEMP "dsx-signing-$([Guid]::NewGuid().ToString('N')).pfx"
$certificate = $null
$importedThumbprints = @()
$password = ConvertTo-SecureString -String $pfxPasswordText -AsPlainText -Force
$pfxPasswordText = $null

try {
    try {
        $pfxBytes = [Convert]::FromBase64String($pfxBase64)
    }
    catch {
        throw 'Windows signing PFX secret is not valid base64.'
    }
    $pfxBase64 = $null
    [System.IO.File]::WriteAllBytes($pfxPath, $pfxBytes)
    [Array]::Clear($pfxBytes, 0, $pfxBytes.Length)

    $importedCertificates = @(Import-PfxCertificate -FilePath $pfxPath `
        -CertStoreLocation 'Cert:\CurrentUser\My' `
        -Password $password `
        -Exportable:$false)
    Remove-Item -LiteralPath $pfxPath -Force
    $importedThumbprints = @(
        Get-ChildItem -LiteralPath 'Cert:\CurrentUser\My' |
            ForEach-Object { Get-NormalizedThumbprint $_.Thumbprint } |
            Where-Object { $_ -notin $existingThumbprints }
    )
    $privateCertificates = @($importedCertificates | Where-Object { $_.HasPrivateKey })
    if ($privateCertificates.Count -ne 1 -or
        (Get-NormalizedThumbprint $privateCertificates[0].Thumbprint) -cne $expected) {
        throw "PFX must import exactly one private signing identity and it must match $expected."
    }
    $certificate = $privateCertificates[0]
    $codeSigningOid = '1.3.6.1.5.5.7.3.3'
    $codeSigningEku = @($certificate.EnhancedKeyUsageList) |
        Where-Object { $_.ObjectId.Value -eq $codeSigningOid }
    if ($codeSigningEku.Count -eq 0 -or -not $certificate.HasPrivateKey) {
        throw 'Imported Windows signing identity is not a private Code Signing certificate.'
    }
    $now = [DateTime]::UtcNow
    if ($certificate.NotBefore.ToUniversalTime() -gt $now -or
        $certificate.NotAfter.ToUniversalTime() -le $now) {
        throw 'Imported Windows signing certificate is not currently valid.'
    }

    $signTool = Resolve-SignTool
    $nativeFiles = @(Get-ChildItem -LiteralPath $image.FullName -Recurse -Force -File |
        Sort-Object FullName |
        ForEach-Object {
            $machine = Get-DsxPeMachineOrNull -File $_
            if ($null -ne $machine) {
                if ($machine -ne 0x8664) {
                    throw ("AppImage native payload {0} has non-x64 machine 0x{1:x4}" -f $_.FullName, $machine)
                }
                $_
            }
        })
    if ($nativeFiles.Count -eq 0) { throw 'AppImage contains no native PE payload.' }

    foreach ($native in $nativeFiles) {
        $signature = Get-AuthenticodeSignature -LiteralPath $native.FullName
        $forceExpectedPublisher = $native.FullName -ieq $launchers[0].FullName
        if ($forceExpectedPublisher -or $signature.Status -eq [System.Management.Automation.SignatureStatus]::NotSigned) {
            Invoke-AuthenticodeSign -SignTool $signTool -File $native -Thumbprint $expected
        }
        elseif ($signature.Status -eq [System.Management.Automation.SignatureStatus]::Valid) {
            [void] (Get-ValidatedSignature -File $native)
        }
        else {
            throw "$($native.FullName) has a broken pre-existing signature: $($signature.Status)"
        }
    }
    [void] (Get-ValidatedSignature -File $launchers[0] -RequiredThumbprint $expected)

    $jpackage = Resolve-Jpackage
    Invoke-JpackageInstaller -Jpackage $jpackage -Type 'msi' -Image $image.FullName -Destination $output.FullName
    Invoke-JpackageInstaller -Jpackage $jpackage -Type 'exe' -Image $image.FullName -Destination $output.FullName

    $msi = @(Get-ChildItem -LiteralPath $output.FullName -Force -File -Filter '*.msi')
    $exe = @(Get-ChildItem -LiteralPath $output.FullName -Force -File -Filter '*.exe')
    if ($msi.Count -ne 1 -or $exe.Count -ne 1) {
        throw "Expected one MSI and one EXE after jpackage; got MSI=$($msi.Count), EXE=$($exe.Count)"
    }
    foreach ($installer in @($msi[0], $exe[0])) {
        Invoke-AuthenticodeSign -SignTool $signTool -File $installer -Thumbprint $expected
    }

    Write-PayloadManifest `
        -Root $image `
        -NativeFiles $nativeFiles `
        -PackageEvidence $packageEvidence `
        -Destination $PayloadManifestOutput
    & "$PSScriptRoot\Verify-DsxWindowsArtifact.ps1" `
        -Artifact @($msi[0].FullName, $exe[0].FullName) `
        -ExpectedVersion $ExpectedVersion `
        -ExpectedAppId $canonicalAppId `
        -ExpectedAppTitle $ExpectedAppTitle `
        -ExpectedBuild $ExpectedBuild `
        -ExpectedEntry $ExpectedEntry `
        -ExpectedAssets $ExpectedAssets `
        -RequireSignature `
        -ExpectedPublisherThumbprint $expected `
        -ManifestOutput $ManifestOutput
}
finally {
    $cleanupFailures = [System.Collections.Generic.List[string]]::new()
    foreach ($thumbprint in $importedThumbprints) {
        try {
            Remove-Item -LiteralPath "Cert:\CurrentUser\My\$thumbprint" -Force -ErrorAction Stop
        }
        catch {
            $cleanupFailures.Add("certificate $thumbprint cleanup failed: $_")
        }
    }
    if (Test-Path -LiteralPath $pfxPath) {
        try {
            Remove-Item -LiteralPath $pfxPath -Force -ErrorAction Stop
        }
        catch {
            $cleanupFailures.Add("temporary PFX cleanup failed: $_")
        }
    }
    if ($null -ne $password) {
        $password.Dispose()
        $password = $null
    }
    if ($cleanupFailures.Count -gt 0) {
        throw ($cleanupFailures -join '; ')
    }
}
