# Exercises the jpackage EXE itself through a complete, reversible per-user
# lifecycle. This must run only on an ephemeral native Windows x64 worker.
#
# The harness refuses to start when the app's upgrade family is already
# registered. It installs and repairs a lower-version fixture through the EXE,
# upgrades through the current EXE, repairs the current payload, rolls back by
# invoking the current EXE's own uninstaller and reinstalling the fixture, then
# invokes the fixture EXE's own uninstaller. Every transition is bound to the
# packaged DSX identity and retained in a provenance-ready JSON record.

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string] $PreviousExePath,

    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string] $CurrentExePath,

    [Parameter(Mandatory = $true)]
    [ValidatePattern('^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$')]
    [string] $PreviousVersion,

    [Parameter(Mandatory = $true)]
    [ValidatePattern('^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$')]
    [string] $CurrentVersion,

    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[A-Za-z0-9][A-Za-z0-9.-]{1,127}$')]
    [string] $ExpectedAppId,

    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$')]
    [string] $ExpectedAppTitle,

    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$')]
    [string] $PreviousBuild,

    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$')]
    [string] $CurrentBuild,

    [AllowEmptyString()]
    [string] $ExpectedEntry = '',

    [AllowEmptyString()]
    [string] $ExpectedAssets = '',

    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[0-9A-Fa-f]{40}$')]
    [string] $ExpectedSourceCommit,

    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[1-9][0-9]*$')]
    [string] $ExpectedWorkflowRunId,

    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[1-9][0-9]*$')]
    [string] $ExpectedWorkflowRunAttempt,

    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string] $EvidenceOutput,

    [ValidateRange(10, 300)]
    [int] $TimeoutSeconds = 120,

    [switch] $SkipUiSmoke,

    [switch] $RequireSignature,

    [ValidatePattern('^[0-9A-Fa-f]{40}$')]
    [string] $ExpectedPublisherThumbprint,

    [string] $PreviousArtifactManifestPath,

    [string] $CurrentArtifactManifestPath,

    [string] $PreviousPayloadManifestPath,

    [string] $CurrentPayloadManifestPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
. "$PSScriptRoot\Get-DsxWindowsPackageEvidence.ps1"

if (-not $IsWindows) {
    throw 'The Windows EXE lifecycle must run on a native Windows host.'
}
if ([Runtime.InteropServices.RuntimeInformation]::OSArchitecture -ne
    [Runtime.InteropServices.Architecture]::X64 -or $env:PROCESSOR_ARCHITECTURE -ne 'AMD64') {
    throw 'The qualified Windows EXE lifecycle requires a native x64 Windows process and host.'
}
if ($ExpectedAppTitle.EndsWith('.') -or
    $ExpectedAppTitle -match '^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\..*)?$') {
    throw 'ExpectedAppTitle is not a portable Windows product/launcher name.'
}
if ($RequireSignature -and (
    [string]::IsNullOrWhiteSpace($ExpectedPublisherThumbprint) -or
    [string]::IsNullOrWhiteSpace($PreviousArtifactManifestPath) -or
    [string]::IsNullOrWhiteSpace($CurrentArtifactManifestPath) -or
    [string]::IsNullOrWhiteSpace($PreviousPayloadManifestPath) -or
    [string]::IsNullOrWhiteSpace($CurrentPayloadManifestPath))) {
    throw 'Signed EXE lifecycle evidence requires publisher, artifact, and payload manifests for both versions.'
}

function Get-DsxProcessTreePids {
    # The launcher + every live descendant (a jpackage exe execs a child java process; the
    # window may belong to either). Recomputed per poll — children spawn after launch.
    param([Parameter(Mandatory = $true)][int] $RootProcessId)
    $all = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
        Select-Object ProcessId, ParentProcessId
    $pids = [System.Collections.Generic.HashSet[uint32]]::new()
    [void] $pids.Add([uint32]$RootProcessId)
    $grew = $true
    while ($grew) {
        $grew = $false
        foreach ($proc in $all) {
            if ($pids.Contains([uint32]$proc.ParentProcessId) -and -not $pids.Contains([uint32]$proc.ProcessId)) {
                [void] $pids.Add([uint32]$proc.ProcessId)
                $grew = $true
            }
        }
    }
    return [uint[]]($pids)
}

function ConvertTo-VersionParts {
    param([Parameter(Mandatory = $true)] [string] $Version)

    $parts = @($Version.Split('.') | ForEach-Object { [uint32] $_ })
    if ($parts[0] -gt 255 -or $parts[1] -gt 255 -or $parts[2] -gt 65535) {
        throw "MSI version requires major/minor <= 255 and build <= 65535: $Version"
    }
    return $parts
}

$previousVersionParts = ConvertTo-VersionParts -Version $PreviousVersion
$currentVersionParts = ConvertTo-VersionParts -Version $CurrentVersion
for ($index = 0; $index -lt 3; $index += 1) {
    if ($previousVersionParts[$index] -lt $currentVersionParts[$index]) { break }
    if ($previousVersionParts[$index] -gt $currentVersionParts[$index]) {
        throw "PreviousVersion $PreviousVersion must be lower than CurrentVersion $CurrentVersion."
    }
    if ($index -eq 2) {
        throw "PreviousVersion $PreviousVersion must be lower than CurrentVersion $CurrentVersion."
    }
}

$canonicalAppId = $ExpectedAppId.ToLowerInvariant()
$launcherName = "$ExpectedAppTitle.exe"

function Assert-SourceProvenance {
    $git = Get-Command 'git.exe' -ErrorAction SilentlyContinue
    if ($null -eq $git) { $git = Get-Command 'git' -ErrorAction SilentlyContinue }
    if ($null -eq $git) { throw 'git is required to bind EXE lifecycle evidence to the checked-out source.' }
    $repositoryRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..\..\..\..'))
    # Capture git's output into a variable first: piping a native command straight
    # into Select-Object -First stops the pipeline early, which can terminate git
    # before $LASTEXITCODE is recorded, and Set-StrictMode -Version Latest then
    # throws when the unset $LASTEXITCODE is read. Read the exit code immediately
    # after git runs to completion, then take the first output line safely.
    $commitOutput = & $git.Source -C $repositoryRoot rev-parse HEAD 2>$null
    $gitExitCode = $LASTEXITCODE
    $actualCommit = ([string] (@($commitOutput) | Select-Object -First 1)).Trim().ToLowerInvariant()
    if ($gitExitCode -ne 0 -or $actualCommit -notmatch '^[0-9a-f]{40}$' -or
        $actualCommit -cne $ExpectedSourceCommit.ToLowerInvariant()) {
        throw "Checked-out source commit $actualCommit does not match $ExpectedSourceCommit."
    }
    if ($env:GITHUB_ACTIONS -eq 'true' -and (
        ([string] $env:GITHUB_SHA).ToLowerInvariant() -cne $ExpectedSourceCommit.ToLowerInvariant() -or
        $env:GITHUB_RUN_ID -cne $ExpectedWorkflowRunId -or
        $env:GITHUB_RUN_ATTEMPT -cne $ExpectedWorkflowRunAttempt)) {
        throw 'GitHub Actions provenance environment does not match the requested EXE lifecycle evidence identity.'
    }
}

Assert-SourceProvenance

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

$expectedUpgradeUuid = Get-DesktopUpgradeUuid -CanonicalAppId $canonicalAppId
$expectedUpgradeCode = "{$($expectedUpgradeUuid.ToUpperInvariant())}"

if (-not ('DsxExeMsiProbe' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class DsxExeMsiProbe {
    [DllImport("msi.dll", CharSet = CharSet.Unicode)]
    public static extern uint MsiEnumRelatedProducts(
        string upgradeCode, uint reserved, uint productIndex, StringBuilder productCode);
    [DllImport("msi.dll", CharSet = CharSet.Unicode)]
    public static extern int MsiQueryProductState(string productCode);
    [DllImport("msi.dll", CharSet = CharSet.Unicode)]
    public static extern uint MsiGetProductInfo(
        string productCode, string property, StringBuilder value, ref uint valueLength);
}
'@
}

function Get-RelatedProductCodes {
    $codes = [System.Collections.Generic.List[string]]::new()
    for ($index = [uint32] 0; $index -lt 128; $index += 1) {
        $buffer = [System.Text.StringBuilder]::new(39)
        $status = [DsxExeMsiProbe]::MsiEnumRelatedProducts(
            $expectedUpgradeCode, 0, $index, $buffer
        )
        if ($status -eq 259) { break } # ERROR_NO_MORE_ITEMS
        if ($status -ne 0) {
            throw "MsiEnumRelatedProducts failed with Win32 status $status."
        }
        $code = $buffer.ToString().ToUpperInvariant()
        if ($code -notmatch '^\{[0-9A-F-]{36}\}$' -or $codes.Contains($code)) {
            throw "Windows Installer returned an invalid or duplicate related ProductCode: $code"
        }
        $codes.Add($code)
    }
    if ($codes.Count -ge 128) {
        throw 'The app upgrade family contains too many related Windows Installer products.'
    }
    return @($codes)
}

function Get-MsiProductInfoValue {
    param(
        [Parameter(Mandatory = $true)] [string] $ProductCode,
        [Parameter(Mandatory = $true)] [ValidatePattern('^[A-Za-z]+$')] [string] $Property
    )

    $length = [uint32] 511
    $buffer = [System.Text.StringBuilder]::new(512)
    $status = [DsxExeMsiProbe]::MsiGetProductInfo($ProductCode, $Property, $buffer, [ref] $length)
    if ($status -eq 234) { # ERROR_MORE_DATA
        if ($length -gt 32767) { throw "MSI $Property value exceeds the bounded limit." }
        $buffer = [System.Text.StringBuilder]::new([int] $length + 1)
        $status = [DsxExeMsiProbe]::MsiGetProductInfo($ProductCode, $Property, $buffer, [ref] $length)
    }
    if ($status -ne 0) {
        throw "MsiGetProductInfo($Property) failed for $ProductCode with Win32 status $status."
    }
    return $buffer.ToString()
}

function Assert-OnlyRelatedProduct {
    param([Parameter(Mandatory = $true)] [string] $ExpectedVersion)

    $codes = @(Get-RelatedProductCodes)
    if ($codes.Count -ne 1) {
        throw "Expected exactly one product in upgrade family $expectedUpgradeCode; found $($codes.Count)."
    }
    $code = $codes[0]
    $state = [DsxExeMsiProbe]::MsiQueryProductState($code)
    if ($state -notin @(3, 5)) {
        throw "Related ProductCode $code is not locally installed (state $state)."
    }
    $version = Get-MsiProductInfoValue -ProductCode $code -Property 'VersionString'
    $name = Get-MsiProductInfoValue -ProductCode $code -Property 'ProductName'
    $publisher = Get-MsiProductInfoValue -ProductCode $code -Property 'Publisher'
    if ($version -cne $ExpectedVersion -or $name -cne $ExpectedAppTitle -or $publisher -cne 'DSX') {
        throw "Installed EXE identity mismatch: ProductCode=$code Version=$version Name=$name Publisher=$publisher"
    }
    return $code
}

function Get-NormalizedThumbprint {
    param([Parameter(Mandatory = $true)] [string] $Value)
    return $Value.Replace(' ', '').ToUpperInvariant()
}

function Get-NativePeMachineOrNull {
    param([Parameter(Mandatory = $true)] [System.IO.FileInfo] $File)

    $stream = [System.IO.File]::Open(
        $File.FullName, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read,
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
                throw "Native file has an invalid PE offset: $($File.FullName)"
            }
            [void] $stream.Seek($peOffset, [System.IO.SeekOrigin]::Begin)
            if ($reader.ReadUInt32() -ne 0x00004550) {
                throw "Native file has an invalid PE signature: $($File.FullName)"
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

function Get-ValidatedInstaller {
    param(
        [Parameter(Mandatory = $true)] [string] $LiteralPath,
        [Parameter(Mandatory = $true)] [string] $Version,
        [string] $ArtifactManifestPath,
        [Parameter(Mandatory = $true)] [string] $Build
    )

    $file = Get-Item -LiteralPath $LiteralPath -Force
    if ($file.PSIsContainer -or $file.LinkType -or $file.Extension -ine '.exe' -or
        $file.Length -lt 65536 -or $file.Length -gt 4GB) {
        throw "EXE lifecycle input is not a bounded regular installer: $LiteralPath"
    }
    $expectedName = "$ExpectedAppTitle-$Version.exe"
    if (-not $file.Name.Equals($expectedName, [StringComparison]::OrdinalIgnoreCase)) {
        throw "EXE lifecycle input must be named $expectedName, got $($file.Name)."
    }
    $machine = Get-NativePeMachineOrNull -File $file
    if ($machine -notin @(0x014c, 0x8664)) {
        throw ("EXE installer has unsupported bootstrapper machine 0x{0:x4}: {1}" -f $machine, $file.FullName)
    }
    $signature = Get-AuthenticodeSignature -LiteralPath $file.FullName
    if ($RequireSignature) {
        if ($signature.Status -ne [System.Management.Automation.SignatureStatus]::Valid -or
            $null -eq $signature.SignerCertificate -or $null -eq $signature.TimeStamperCertificate) {
            throw "$($file.Name) is not validly signed and RFC 3161 timestamped."
        }
        $actualThumbprint = Get-NormalizedThumbprint $signature.SignerCertificate.Thumbprint
        if ($actualThumbprint -cne (Get-NormalizedThumbprint $ExpectedPublisherThumbprint)) {
            throw "$($file.Name) publisher thumbprint mismatch: $actualThumbprint"
        }
        $codeSigningOid = '1.3.6.1.5.5.7.3.3'
        if (@($signature.SignerCertificate.EnhancedKeyUsageList |
            Where-Object { $_.ObjectId.Value -eq $codeSigningOid }).Count -ne 1) {
            throw "$($file.Name) signer certificate lacks the Code Signing EKU."
        }
        $now = [DateTime]::UtcNow
        if ($signature.SignerCertificate.NotBefore.ToUniversalTime() -gt $now -or
            $signature.SignerCertificate.NotAfter.ToUniversalTime() -le $now) {
            throw "$($file.Name) signer certificate is not currently valid."
        }
    }

    $hash = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
    $manifestHash = $null
    if (-not [string]::IsNullOrWhiteSpace($ArtifactManifestPath)) {
        $manifestFile = Get-Item -LiteralPath $ArtifactManifestPath -Force
        if ($manifestFile.PSIsContainer -or $manifestFile.LinkType -or $manifestFile.Length -gt 1MB) {
            throw "Artifact manifest is not a regular file: $ArtifactManifestPath"
        }
        $manifest = Get-Content -LiteralPath $manifestFile.FullName -Raw | ConvertFrom-Json
        if ($manifest.schema -ne 'dev.dsx.windows-artifacts/v1' -or
            $manifest.applicationId -cne $canonicalAppId -or
            $manifest.product -cne $ExpectedAppTitle -or
            $manifest.version -cne $Version -or $manifest.build -cne $Build -or
            $manifest.entry -cne $ExpectedEntry -or $manifest.assets -cne $ExpectedAssets -or
            [bool] $manifest.signed -ne [bool] $RequireSignature) {
            throw "Artifact manifest identity does not match $($file.Name)."
        }
        $records = @($manifest.artifacts)
        $extensions = @($records | ForEach-Object { [System.IO.Path]::GetExtension([string] $_.file).ToLowerInvariant() } | Sort-Object)
        if ($records.Count -ne 2 -or ($extensions -join ',') -cne '.exe,.msi') {
            throw 'Artifact manifest must bind exactly one MSI and one EXE.'
        }
        $record = @($records | Where-Object { [System.IO.Path]::GetExtension([string] $_.file) -ieq '.exe' })
        if ($record.Count -ne 1 -or
            -not ([string] $record[0].file).Equals($file.Name, [StringComparison]::OrdinalIgnoreCase) -or
            [long] $record[0].bytes -ne $file.Length -or
            ([string] $record[0].sha256).ToLowerInvariant() -cne $hash) {
            throw "Artifact manifest does not bind the exact EXE bytes: $($file.Name)"
        }
        if ($RequireSignature -and (
            $record[0].signatureStatus -cne 'Valid' -or $record[0].timestamped -ne $true -or
            (Get-NormalizedThumbprint ([string] $record[0].signerThumbprint)) -cne
                (Get-NormalizedThumbprint $ExpectedPublisherThumbprint))) {
            throw "Artifact manifest does not bind the signed EXE publisher: $($file.Name)"
        }
        $manifestHash = (Get-FileHash -LiteralPath $manifestFile.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
    }

    return [pscustomobject]@{
        Path = $file.FullName
        File = $file.Name
        Bytes = $file.Length
        Sha256 = $hash
        BootstrapperMachine = ('0x{0:x4}' -f $machine)
        SignatureStatus = $signature.Status.ToString()
        SignerThumbprint = if ($null -ne $signature.SignerCertificate) {
            $signature.SignerCertificate.Thumbprint.ToLowerInvariant()
        } else { $null }
        Timestamped = ($null -ne $signature.TimeStamperCertificate)
        ArtifactManifestSha256 = $manifestHash
    }
}

function Invoke-ExeInstaller {
    param(
        [Parameter(Mandatory = $true)] [string] $LiteralPath,
        [Parameter(Mandatory = $true)] [string[]] $Arguments,
        [Parameter(Mandatory = $true)] [string] $Stage,
        [switch] $Cleanup
    )

    $start = [System.Diagnostics.ProcessStartInfo]::new()
    $start.FileName = $LiteralPath
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    foreach ($argument in $Arguments) { $start.ArgumentList.Add($argument) }
    $process = [System.Diagnostics.Process]::Start($start)
    if ($null -eq $process) { throw "Could not start the EXE installer for $Stage." }
    try {
        if (-not $process.WaitForExit($TimeoutSeconds * 1000)) {
            $process.Kill($true)
            throw "EXE installer timed out during $Stage."
        }
        $allowed = if ($Cleanup) { @(0, 1605, 1641, 3010) } else { @(0, 1641, 3010) }
        if ($process.ExitCode -notin $allowed) {
            throw "EXE installer failed during $Stage with exit code $($process.ExitCode)."
        }
        return $process.ExitCode
    }
    finally {
        $process.Dispose()
    }
}

function Invoke-DsxSelfTest {
    param(
        [Parameter(Mandatory = $true)] [string] $Launcher,
        [Parameter(Mandatory = $true)] [string] $OutputPath
    )

    if (Test-Path -LiteralPath $OutputPath) { Remove-Item -LiteralPath $OutputPath -Force }
    $start = [System.Diagnostics.ProcessStartInfo]::new()
    $start.FileName = $Launcher
    $start.UseShellExecute = $false
    $start.ArgumentList.Add('--dsx-self-test')
    $start.ArgumentList.Add('--dsx-self-test-output')
    $start.ArgumentList.Add($OutputPath)
    $process = [System.Diagnostics.Process]::Start($start)
    try {
        if (-not $process.WaitForExit($TimeoutSeconds * 1000)) {
            $process.Kill($true)
            throw 'Packaged DSX self-test timed out during the EXE lifecycle.'
        }
        if ($process.ExitCode -ne 0) { throw "Packaged DSX self-test exited $($process.ExitCode)." }
    }
    finally {
        $process.Dispose()
    }
    $result = Get-Content -LiteralPath $OutputPath -Raw | ConvertFrom-Json
    if ($result.schema -ne 'dev.dsx.desktop-self-test/v1' -or $result.status -ne 'ok' -or
        $result.os -ne 'windows' -or $result.desktop -ne $true) {
        throw "Packaged DSX self-test returned an invalid contract: $($result | ConvertTo-Json -Compress)"
    }
    return $result
}

function Invoke-DsxUiSmoke {
    param([Parameter(Mandatory = $true)] [string] $Launcher)

    if (-not ('DsxExeWindowProbe' -as [type])) {
        Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class DsxExeWindowProbe {
    private delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left, Top, Right, Bottom; }
    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);
    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetWindowTextLength(IntPtr hWnd);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetWindowText(IntPtr hWnd, StringBuilder value, int maxCount);
    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
    // A jpackage app's window is not reliably reported by Process.MainWindowHandle
    // (the native launcher's process/window association is opaque to .NET), so match
    // the proven QA-demo probe: enumerate every top-level window and take the first
    // visible one whose title begins with the expected app title.
    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
    // BOUND TO THE PROCESS UNDER TEST: the window must belong to one of the allowed PIDs
    // (the launcher + its descendants). Title-prefix alone let ANY DSX-titled window on the
    // runner satisfy the smoke — this lifecycle runs TWO smokes with the same title
    // (upgrade + rollback), so a leftover window from the first satisfied the second, and
    // the QA demo's "DSX Desktop QA" StartsWith-matches the default "DSX" title. The lane
    // must prove THIS binary opened a window, not that one exists.
    public static IntPtr FindVisibleWindowByTitlePrefix(string expectedTitlePrefix, uint[] allowedPids) {
        IntPtr match = IntPtr.Zero;
        EnumWindows(delegate(IntPtr hWnd, IntPtr lParam) {
            if (!IsWindowVisible(hWnd)) return true;
            uint windowPid;
            GetWindowThreadProcessId(hWnd, out windowPid);
            if (Array.IndexOf(allowedPids, windowPid) < 0) return true;
            int length = GetWindowTextLength(hWnd);
            if (length <= 0) return true;
            StringBuilder title = new StringBuilder(length + 1);
            GetWindowText(hWnd, title, title.Capacity);
            if (title.ToString().StartsWith(expectedTitlePrefix, StringComparison.Ordinal)) {
                match = hWnd;
                return false;
            }
            return true;
        }, IntPtr.Zero);
        return match;
    }
}
'@
    }
    $process = Start-Process -FilePath $Launcher -ArgumentList @('--dsx-ui-smoke') -PassThru
    try {
        $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
        $handle = [IntPtr]::Zero
        while ([DateTime]::UtcNow -lt $deadline) {
            if ($process.HasExited) {
                throw "$ExpectedAppTitle exited before opening its EXE-installed native window."
            }
            $allowedPids = Get-DsxProcessTreePids -RootProcessId $process.Id
            $handle = [DsxExeWindowProbe]::FindVisibleWindowByTitlePrefix($ExpectedAppTitle, $allowedPids)
            if ($handle -ne [IntPtr]::Zero) { break }
            Start-Sleep -Milliseconds 250
        }
        if ($handle -eq [IntPtr]::Zero) {
            throw "$ExpectedAppTitle did not create a visible EXE-installed native window."
        }
        $rect = [DsxExeWindowProbe+RECT]::new()
        if (-not [DsxExeWindowProbe]::GetWindowRect($handle, [ref] $rect) -or
            ($rect.Right - $rect.Left) -lt 320 -or ($rect.Bottom - $rect.Top) -lt 240) {
            throw "$ExpectedAppTitle EXE-installed native window has invalid bounds."
        }
    }
    finally {
        # MainWindowHandle is unreliable for this launcher, so CloseMainWindow cannot
        # ask the app to exit. Terminate the launcher tree and WAIT for it, so the app
        # releases the jars it loaded (Windows keeps them locked while the process
        # lives) before the next install/repair stage opens them.
        if (-not $process.HasExited) { $process.Kill($true) }
        [void] $process.WaitForExit(10000)
        $process.Dispose()
    }
}

function Get-ShortcutPaths {
    return @(
        (Join-Path ([Environment]::GetFolderPath('Desktop')) "$ExpectedAppTitle.lnk"),
        (Join-Path (Join-Path ([Environment]::GetFolderPath('Programs')) 'DSX') "$ExpectedAppTitle.lnk")
    )
}

function Assert-ShortcutsTargetLauncher {
    param([Parameter(Mandatory = $true)] [string] $Launcher)

    $shell = New-Object -ComObject WScript.Shell
    try {
        foreach ($path in Get-ShortcutPaths) {
            $file = Get-Item -LiteralPath $path -Force
            if ($file.PSIsContainer -or $file.LinkType) { throw "Unsafe installed shortcut: $path" }
            $shortcut = $shell.CreateShortcut($file.FullName)
            if (-not ([System.IO.Path]::GetFullPath($shortcut.TargetPath)).Equals(
                [System.IO.Path]::GetFullPath($Launcher), [StringComparison]::OrdinalIgnoreCase)) {
                throw "Installed shortcut does not target the verified launcher: $path"
            }
            if (-not [string]::IsNullOrWhiteSpace($shortcut.Arguments)) {
                throw "Installed shortcut injects unexpected arguments: $path"
            }
        }
    }
    finally {
        if ([Runtime.InteropServices.Marshal]::IsComObject($shell)) {
            [void] [Runtime.InteropServices.Marshal]::FinalReleaseComObject($shell)
        }
    }
}

function Assert-NoLifecycleResidue {
    param([Parameter(Mandatory = $true)] [string] $InstallRoot)

    $related = @(Get-RelatedProductCodes)
    if ($related.Count -ne 0) {
        throw "EXE lifecycle left related ProductCodes registered: $($related -join ', ')"
    }
    foreach ($shortcut in Get-ShortcutPaths) {
        if (Test-Path -LiteralPath $shortcut) { throw "EXE lifecycle left a shortcut installed: $shortcut" }
    }
    if (Test-Path -LiteralPath $InstallRoot) {
        $launchers = @(Get-ChildItem -LiteralPath $InstallRoot -Recurse -Force -File -Filter $launcherName)
        if ($launchers.Count -ne 0) { throw "EXE lifecycle left the launcher installed under $InstallRoot." }
    }
}

function Assert-PayloadManifest {
    param(
        [Parameter(Mandatory = $true)] [string] $ApplicationRoot,
        [Parameter(Mandatory = $true)] [string] $Launcher,
        [Parameter(Mandatory = $true)] [string] $ManifestPath,
        [Parameter(Mandatory = $true)] [object] $PackageEvidence
    )

    $manifestFile = Get-Item -LiteralPath $ManifestPath -Force
    if ($manifestFile.PSIsContainer -or $manifestFile.LinkType -or $manifestFile.Length -gt 64MB) {
        throw "Payload manifest is not a regular file: $ManifestPath"
    }
    $manifest = Get-Content -LiteralPath $manifestFile.FullName -Raw | ConvertFrom-Json
    if ($manifest.schema -ne 'dev.dsx.windows-payload/v2' -or
        $null -eq $manifest.packageEvidence -or @($manifest.files).Count -eq 0 -or
        @($manifest.files).Count -gt 100000) {
        throw "Invalid payload manifest: $ManifestPath"
    }
    Assert-DsxWindowsPackageEvidenceMatch -Recorded $manifest.packageEvidence -Installed $PackageEvidence

    $root = [System.IO.Path]::GetFullPath($ApplicationRoot)
    $rootPrefix = $root.TrimEnd('\') + '\'
    $seen = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    foreach ($record in @($manifest.files)) {
        $relative = [string] $record.path
        $segments = @($relative.Split('/'))
        $unsafeSegments = @($segments | Where-Object {
            $_ -eq '' -or $_ -eq '.' -or $_ -eq '..' -or $_.Length -gt 255 -or
            $_.EndsWith('.') -or $_.EndsWith(' ') -or
            $_ -match '^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\..*)?$'
        })
        if ([string]::IsNullOrWhiteSpace($relative) -or $relative.Length -gt 32767 -or
            $relative -cne $relative.Normalize([Text.NormalizationForm]::FormC) -or
            $relative -match '[\x00-\x1f<>:"|?*]' -or $relative.Contains('\') -or
            [System.IO.Path]::IsPathRooted($relative) -or
            $unsafeSegments.Count -ne 0) {
            throw "Unsafe payload-manifest path: $relative"
        }
        $target = [System.IO.Path]::GetFullPath((Join-Path $root $relative.Replace('/', '\')))
        if (-not $target.StartsWith($rootPrefix, [StringComparison]::OrdinalIgnoreCase) -or
            -not $seen.Add($target)) {
            throw "Duplicate or escaping payload-manifest path: $relative"
        }
        $file = Get-Item -LiteralPath $target -Force
        if ($file.PSIsContainer -or $file.LinkType -or $file.Length -ne [long] $record.bytes) {
            throw "Installed payload identity mismatch: $relative"
        }
        $hash = (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($hash -cne ([string] $record.sha256).ToLowerInvariant()) {
            throw "Installed payload hash mismatch: $relative"
        }
        $machine = Get-NativePeMachineOrNull -File $file
        if ($null -ne $machine) {
            if ($machine -ne 0x8664 -or $null -eq $record.authenticode) {
                throw "Installed EXE payload is not manifest-bound x64: $relative"
            }
            $signature = Get-AuthenticodeSignature -LiteralPath $file.FullName
            if ($signature.Status -ne [System.Management.Automation.SignatureStatus]::Valid -or
                $null -eq $signature.SignerCertificate -or $null -eq $signature.TimeStamperCertificate -or
                $record.authenticode.signatureStatus -cne 'Valid' -or
                $record.authenticode.timestamped -ne $true -or
                (Get-NormalizedThumbprint $signature.SignerCertificate.Thumbprint) -cne
                    (Get-NormalizedThumbprint ([string] $record.authenticode.signerThumbprint))) {
                throw "Installed native signature does not match the payload manifest: $relative"
            }
        }
        elseif ($null -ne $record.authenticode) {
            throw "Payload manifest marks a non-PE file as Authenticode signed: $relative"
        }
    }
    $installedFiles = @(Get-ChildItem -LiteralPath $root -Recurse -Force -File)
    if ($installedFiles.Count -ne $seen.Count) {
        throw "Installed payload file count $($installedFiles.Count) does not match manifest $($seen.Count)."
    }
    $launcherSignature = Get-AuthenticodeSignature -LiteralPath $Launcher
    if ((Get-NormalizedThumbprint $launcherSignature.SignerCertificate.Thumbprint) -cne
        (Get-NormalizedThumbprint $ExpectedPublisherThumbprint)) {
        throw 'Installed launcher publisher does not match the protected release publisher.'
    }
    return (Get-FileHash -LiteralPath $manifestFile.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Get-InstalledRelease {
    param(
        [Parameter(Mandatory = $true)] [string] $InstallRoot,
        [Parameter(Mandatory = $true)] [string] $Version,
        [Parameter(Mandatory = $true)] [string] $Build,
        [string] $PayloadManifestPath,
        [Parameter(Mandatory = $true)] [string] $SelfTestOutput
    )

    $launchers = @(Get-ChildItem -LiteralPath $InstallRoot -Recurse -Force -File -Filter $launcherName)
    if ($launchers.Count -ne 1 -or $launchers[0].LinkType) {
        throw "Expected exactly one installed $launcherName under $InstallRoot; found $($launchers.Count)."
    }
    $launcher = $launchers[0].FullName
    $applicationRoot = [System.IO.Path]::GetDirectoryName($launcher)
    $installPrefix = [System.IO.Path]::GetFullPath($InstallRoot).TrimEnd('\') + '\'
    if (-not ([System.IO.Path]::GetFullPath($applicationRoot) + '\').StartsWith(
        $installPrefix, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Installed launcher escaped the lifecycle install root.'
    }
    $reparsePoints = @(Get-ChildItem -LiteralPath $applicationRoot -Recurse -Force |
        Where-Object { ($_.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0 })
    if ($reparsePoints.Count -ne 0) { throw "Installed payload contains a reparse point: $($reparsePoints[0].FullName)" }
    $nativeCount = 0
    foreach ($file in @(Get-ChildItem -LiteralPath $applicationRoot -Recurse -Force -File)) {
        $machine = Get-NativePeMachineOrNull -File $file
        if ($null -eq $machine) { continue }
        $nativeCount += 1
        if ($machine -ne 0x8664) {
            throw ("Installed native payload has non-x64 machine 0x{0:x4}: {1}" -f $machine, $file.FullName)
        }
    }
    if ($nativeCount -eq 0) { throw 'Installed EXE payload contains no native x64 files.' }
    $packageEvidence = Get-DsxWindowsPackageEvidence `
        -ApplicationRoot $applicationRoot -Launcher $launcher `
        -ExpectedVersion $Version -ExpectedAppId $canonicalAppId `
        -ExpectedAppTitle $ExpectedAppTitle -ExpectedBuild $Build `
        -ExpectedEntry $ExpectedEntry -ExpectedAssets $ExpectedAssets
    $payloadManifestSha256 = $null
    if ($RequireSignature) {
        $payloadManifestSha256 = Assert-PayloadManifest `
            -ApplicationRoot $applicationRoot -Launcher $launcher `
            -ManifestPath $PayloadManifestPath -PackageEvidence $packageEvidence
    }
    Assert-ShortcutsTargetLauncher -Launcher $launcher
    $selfTest = Invoke-DsxSelfTest -Launcher $launcher -OutputPath $SelfTestOutput
    return [pscustomobject]@{
        Launcher = $launcher
        ApplicationRoot = $applicationRoot
        PackageEvidence = $packageEvidence
        PayloadManifestSha256 = $payloadManifestSha256
        SelfTest = $selfTest
    }
}

function Invoke-VerifiedRepair {
    param(
        [Parameter(Mandatory = $true)] [object] $Installer,
        [Parameter(Mandatory = $true)] [object] $Installed,
        [Parameter(Mandatory = $true)] [string] $InstallRoot,
        [Parameter(Mandatory = $true)] [string] $Version,
        [Parameter(Mandatory = $true)] [string] $Build,
        [string] $PayloadManifestPath,
        [Parameter(Mandatory = $true)] [string] $LogPath,
        [Parameter(Mandatory = $true)] [string] $SelfTestOutput,
        [Parameter(Mandatory = $true)] [string] $Stage
    )

    $repairTarget = @(Get-ChildItem -LiteralPath $Installed.ApplicationRoot -Recurse -Force -File |
        Where-Object { $_.Extension -ieq '.jar' } | Sort-Object Length -Descending | Select-Object -First 1)
    if ($repairTarget.Count -ne 1 -or $repairTarget[0].Length -lt 2) {
        throw 'EXE repair could not select a packaged JAR corruption canary.'
    }
    $originalHash = (Get-FileHash -LiteralPath $repairTarget[0].FullName -Algorithm SHA256).Hash.ToLowerInvariant()
    # A just-run UI smoke spawns a child JVM that keeps the packaged jars memory-mapped
    # for a short moment after it is killed, so this exclusive open can briefly lose the
    # race with the OS releasing the handle. Retry until it frees instead of failing the
    # repair on that transient lock.
    $stream = $null
    $openDeadline = [DateTime]::UtcNow.AddSeconds(30)
    while ($null -eq $stream) {
        try {
            $stream = [System.IO.File]::Open(
                $repairTarget[0].FullName, [System.IO.FileMode]::Open,
                [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None
            )
        }
        catch [System.IO.IOException] {
            if ([DateTime]::UtcNow -ge $openDeadline) { throw }
            Start-Sleep -Milliseconds 500
        }
    }
    try {
        $first = $stream.ReadByte()
        [void] $stream.Seek(0, [System.IO.SeekOrigin]::Begin)
        $stream.WriteByte([byte] ($first -bxor 0xff))
        $stream.Flush($true)
    }
    finally { $stream.Dispose() }
    if ((Get-FileHash -LiteralPath $repairTarget[0].FullName -Algorithm SHA256).Hash.ToLowerInvariant() -ceq $originalHash) {
        throw 'EXE repair corruption canary did not change the selected payload.'
    }
    $exitCode = Invoke-ExeInstaller -LiteralPath $Installer.Path -Stage $Stage -Arguments @(
        '/qn', '/norestart', 'REINSTALL=ALL', 'REINSTALLMODE=vamus',
        "INSTALLDIR=$InstallRoot", '/l*v', $LogPath
    )
    $repairedHash = (Get-FileHash -LiteralPath $repairTarget[0].FullName -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($repairedHash -cne $originalHash) {
        throw "EXE repair did not restore the deliberately damaged payload: $($repairTarget[0].FullName)"
    }
    $verified = Get-InstalledRelease `
        -InstallRoot $InstallRoot -Version $Version -Build $Build `
        -PayloadManifestPath $PayloadManifestPath -SelfTestOutput $SelfTestOutput
    return [pscustomobject]@{
        ExitCode = $exitCode
        CorruptionCanary = [System.IO.Path]::GetRelativePath($Installed.ApplicationRoot, $repairTarget[0].FullName).Replace('\', '/')
        RestoredSha256 = $repairedHash
        LogSha256 = (Get-FileHash -LiteralPath $LogPath -Algorithm SHA256).Hash.ToLowerInvariant()
        Installed = $verified
    }
}

$previousInstaller = Get-ValidatedInstaller `
    -LiteralPath $PreviousExePath -Version $PreviousVersion -Build $PreviousBuild `
    -ArtifactManifestPath $PreviousArtifactManifestPath
$currentInstaller = Get-ValidatedInstaller `
    -LiteralPath $CurrentExePath -Version $CurrentVersion -Build $CurrentBuild `
    -ArtifactManifestPath $CurrentArtifactManifestPath
if ($previousInstaller.Path.Equals($currentInstaller.Path, [StringComparison]::OrdinalIgnoreCase) -or
    $previousInstaller.Sha256 -ceq $currentInstaller.Sha256) {
    throw 'Previous and current EXE lifecycle inputs must be distinct installers.'
}

$evidencePath = [System.IO.Path]::GetFullPath($EvidenceOutput)
if (Test-Path -LiteralPath $evidencePath) { throw "EvidenceOutput already exists: $evidencePath" }
$evidenceName = [System.IO.Path]::GetFileName($evidencePath)
if (-not $evidenceName.EndsWith('.json', [StringComparison]::OrdinalIgnoreCase) -or
    $evidenceName.IndexOfAny([System.IO.Path]::GetInvalidFileNameChars()) -ne -1) {
    throw 'EvidenceOutput must use a regular Windows .json filename.'
}
$evidenceParent = [System.IO.Path]::GetDirectoryName($evidencePath)
[System.IO.Directory]::CreateDirectory($evidenceParent) | Out-Null
$parentInfo = Get-Item -LiteralPath $evidenceParent -Force
if (-not $parentInfo.PSIsContainer -or $parentInfo.LinkType) {
    throw "EvidenceOutput parent must be a real directory: $evidenceParent"
}

$testRoot = Join-Path $env:RUNNER_TEMP "dsx-windows-exe-lifecycle-$([Guid]::NewGuid().ToString('N'))"
$installRoot = Join-Path $testRoot 'app'
[System.IO.Directory]::CreateDirectory($installRoot) | Out-Null
$selfTestOutput = Join-Path $testRoot 'self-test.json'
$stageRecords = [System.Collections.Generic.List[object]]::new()
$primaryFailure = $null
$cleanupFailures = [System.Collections.Generic.List[string]]::new()
$lifecycleStarted = $false
$previousProductCode = $null
$currentProductCode = $null
$rollbackProductCode = $null

try {
    if (@(Get-RelatedProductCodes).Count -ne 0) {
        throw "Refusing EXE lifecycle because upgrade family $expectedUpgradeCode is already registered."
    }
    foreach ($shortcut in Get-ShortcutPaths) {
        if (Test-Path -LiteralPath $shortcut) {
            throw "Refusing EXE lifecycle because a target shortcut already exists: $shortcut"
        }
    }

    # Cleanup is authorized only after both non-mutation preflights proved that
    # this upgrade family and its shortcuts did not predate the harness.
    $lifecycleStarted = $true
    $previousInstallLog = Join-Path $testRoot 'previous-install.log'
    $exit = Invoke-ExeInstaller -LiteralPath $previousInstaller.Path -Stage 'previous-install' -Arguments @(
        '/qn', '/norestart', 'ALLUSERS=2', 'MSIINSTALLPERUSER=1',
        "INSTALLDIR=$installRoot", '/l*v', $previousInstallLog
    )
    $previousProductCode = Assert-OnlyRelatedProduct -ExpectedVersion $PreviousVersion
    $previousInstalled = Get-InstalledRelease `
        -InstallRoot $installRoot -Version $PreviousVersion -Build $PreviousBuild `
        -PayloadManifestPath $PreviousPayloadManifestPath -SelfTestOutput $selfTestOutput
    $stageRecords.Add([ordered]@{
        stage = 'install-previous'; exitCode = $exit; productCode = $previousProductCode
        version = $PreviousVersion; packageEvidence = $previousInstalled.PackageEvidence
        selfTest = $previousInstalled.SelfTest
        logSha256 = (Get-FileHash -LiteralPath $previousInstallLog -Algorithm SHA256).Hash.ToLowerInvariant()
    })

    $previousRepair = Invoke-VerifiedRepair `
        -Installer $previousInstaller -Installed $previousInstalled -InstallRoot $installRoot `
        -Version $PreviousVersion -Build $PreviousBuild -PayloadManifestPath $PreviousPayloadManifestPath `
        -LogPath (Join-Path $testRoot 'previous-repair.log') -SelfTestOutput $selfTestOutput `
        -Stage 'previous-repair'
    if ((Assert-OnlyRelatedProduct -ExpectedVersion $PreviousVersion) -cne $previousProductCode) {
        throw 'EXE repair changed the previous ProductCode.'
    }
    $stageRecords.Add([ordered]@{
        stage = 'repair-previous'; exitCode = $previousRepair.ExitCode; productCode = $previousProductCode
        version = $PreviousVersion; corruptionCanary = $previousRepair.CorruptionCanary
        restoredSha256 = $previousRepair.RestoredSha256
        packageEvidence = $previousRepair.Installed.PackageEvidence
        selfTest = $previousRepair.Installed.SelfTest; logSha256 = $previousRepair.LogSha256
    })

    $upgradeLog = Join-Path $testRoot 'upgrade-current.log'
    $exit = Invoke-ExeInstaller -LiteralPath $currentInstaller.Path -Stage 'upgrade-current' -Arguments @(
        '/qn', '/norestart', 'ALLUSERS=2', 'MSIINSTALLPERUSER=1',
        "INSTALLDIR=$installRoot", '/l*v', $upgradeLog
    )
    $currentProductCode = Assert-OnlyRelatedProduct -ExpectedVersion $CurrentVersion
    if ($currentProductCode -ceq $previousProductCode -or
        [DsxExeMsiProbe]::MsiQueryProductState($previousProductCode) -ne -1) {
        throw 'EXE upgrade did not replace the previous ProductCode with a distinct current ProductCode.'
    }
    $currentInstalled = Get-InstalledRelease `
        -InstallRoot $installRoot -Version $CurrentVersion -Build $CurrentBuild `
        -PayloadManifestPath $CurrentPayloadManifestPath -SelfTestOutput $selfTestOutput
    if (-not $SkipUiSmoke) { Invoke-DsxUiSmoke -Launcher $currentInstalled.Launcher }
    $stageRecords.Add([ordered]@{
        stage = 'upgrade-current'; exitCode = $exit; productCode = $currentProductCode
        replacedProductCode = $previousProductCode; version = $CurrentVersion
        packageEvidence = $currentInstalled.PackageEvidence; uiSmoke = (-not $SkipUiSmoke)
        selfTest = $currentInstalled.SelfTest
        logSha256 = (Get-FileHash -LiteralPath $upgradeLog -Algorithm SHA256).Hash.ToLowerInvariant()
    })

    $currentRepair = Invoke-VerifiedRepair `
        -Installer $currentInstaller -Installed $currentInstalled -InstallRoot $installRoot `
        -Version $CurrentVersion -Build $CurrentBuild -PayloadManifestPath $CurrentPayloadManifestPath `
        -LogPath (Join-Path $testRoot 'current-repair.log') -SelfTestOutput $selfTestOutput `
        -Stage 'current-repair'
    if ((Assert-OnlyRelatedProduct -ExpectedVersion $CurrentVersion) -cne $currentProductCode) {
        throw 'EXE repair changed the current ProductCode.'
    }
    $stageRecords.Add([ordered]@{
        stage = 'repair-current'; exitCode = $currentRepair.ExitCode; productCode = $currentProductCode
        version = $CurrentVersion; corruptionCanary = $currentRepair.CorruptionCanary
        restoredSha256 = $currentRepair.RestoredSha256
        packageEvidence = $currentRepair.Installed.PackageEvidence
        selfTest = $currentRepair.Installed.SelfTest; logSha256 = $currentRepair.LogSha256
    })

    $exit = Invoke-ExeInstaller -LiteralPath $currentInstaller.Path -Stage 'rollback-remove-current' -Arguments @('uninstall')
    if (@(Get-RelatedProductCodes).Count -ne 0 -or
        [DsxExeMsiProbe]::MsiQueryProductState($currentProductCode) -ne -1) {
        throw 'Current EXE uninstaller did not clear the upgrade family before rollback.'
    }
    Assert-NoLifecycleResidue -InstallRoot $installRoot
    $stageRecords.Add([ordered]@{
        stage = 'rollback-remove-current'; exitCode = $exit; productCode = $currentProductCode
        version = $CurrentVersion
    })

    $rollbackLog = Join-Path $testRoot 'rollback-previous.log'
    $exit = Invoke-ExeInstaller -LiteralPath $previousInstaller.Path -Stage 'rollback-install-previous' -Arguments @(
        '/qn', '/norestart', 'ALLUSERS=2', 'MSIINSTALLPERUSER=1',
        "INSTALLDIR=$installRoot", '/l*v', $rollbackLog
    )
    $rollbackProductCode = Assert-OnlyRelatedProduct -ExpectedVersion $PreviousVersion
    if ($rollbackProductCode -cne $previousProductCode) {
        throw 'Rollback reinstall did not restore the original previous ProductCode.'
    }
    $rollbackInstalled = Get-InstalledRelease `
        -InstallRoot $installRoot -Version $PreviousVersion -Build $PreviousBuild `
        -PayloadManifestPath $PreviousPayloadManifestPath -SelfTestOutput $selfTestOutput
    if (-not $SkipUiSmoke) { Invoke-DsxUiSmoke -Launcher $rollbackInstalled.Launcher }
    $stageRecords.Add([ordered]@{
        stage = 'rollback-install-previous'; exitCode = $exit; productCode = $rollbackProductCode
        replacedProductCode = $currentProductCode; version = $PreviousVersion
        packageEvidence = $rollbackInstalled.PackageEvidence; uiSmoke = (-not $SkipUiSmoke)
        selfTest = $rollbackInstalled.SelfTest
        logSha256 = (Get-FileHash -LiteralPath $rollbackLog -Algorithm SHA256).Hash.ToLowerInvariant()
    })

    $exit = Invoke-ExeInstaller -LiteralPath $previousInstaller.Path -Stage 'uninstall-previous' -Arguments @('uninstall')
    Assert-NoLifecycleResidue -InstallRoot $installRoot
    $stageRecords.Add([ordered]@{
        stage = 'uninstall-previous'; exitCode = $exit; productCode = $rollbackProductCode
        version = $PreviousVersion; relatedProductCount = 0; shortcutsRemoved = $true
    })
}
catch {
    $primaryFailure = $_
}
finally {
    # Cleanup is intentionally defensive and separate from lifecycle success.
    # The test still fails if its EXE uninstall path failed, but the ephemeral
    # worker must not retain a product registration for a later job step.
    if ($lifecycleStarted) {
        foreach ($installer in @($currentInstaller.Path, $previousInstaller.Path)) {
            if (@(Get-RelatedProductCodes).Count -eq 0) { break }
            try { [void] (Invoke-ExeInstaller -LiteralPath $installer -Stage 'emergency-cleanup' -Arguments @('uninstall') -Cleanup) }
            catch { $cleanupFailures.Add("EXE emergency cleanup failed for $installer`: $_") }
        }
        foreach ($code in @(Get-RelatedProductCodes)) {
            try {
                $cleanupVersion = Get-MsiProductInfoValue -ProductCode $code -Property 'VersionString'
                $cleanupName = Get-MsiProductInfoValue -ProductCode $code -Property 'ProductName'
                $cleanupPublisher = Get-MsiProductInfoValue -ProductCode $code -Property 'Publisher'
                if ($cleanupVersion -notin @($PreviousVersion, $CurrentVersion) -or
                    $cleanupName -cne $ExpectedAppTitle -or $cleanupPublisher -cne 'DSX') {
                    throw "Refusing emergency removal of unrecognized related product $code."
                }
                $process = Start-Process -FilePath "$env:SystemRoot\System32\msiexec.exe" `
                    -ArgumentList @('/x', $code, '/qn', '/norestart') -Wait -PassThru -NoNewWindow
                try {
                    if ($process.ExitCode -notin @(0, 1605, 1641, 3010)) {
                        throw "msiexec emergency uninstall exited $($process.ExitCode)"
                    }
                }
                finally { $process.Dispose() }
            }
            catch { $cleanupFailures.Add("MSI emergency cleanup failed for $code`: $_") }
        }
        try {
            Assert-NoLifecycleResidue -InstallRoot $installRoot
        }
        catch { $cleanupFailures.Add("Final EXE lifecycle residue check failed: $_") }
    }
    try {
        if (Test-Path -LiteralPath $testRoot) { Remove-Item -LiteralPath $testRoot -Recurse -Force }
    }
    catch { $cleanupFailures.Add("EXE lifecycle test-root cleanup failed: $_") }
}

if ($null -ne $primaryFailure) { throw $primaryFailure }
if ($cleanupFailures.Count -ne 0) { throw ($cleanupFailures -join '; ') }

foreach ($installer in @($previousInstaller, $currentInstaller)) {
    $finalHash = (Get-FileHash -LiteralPath $installer.Path -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($finalHash -cne $installer.Sha256) {
        throw "EXE installer bytes changed during lifecycle execution: $($installer.Path)"
    }
}

$evidence = [ordered]@{
    schema = 'dev.dsx.windows-exe-lifecycle/v1'
    status = 'ok'
    source = [ordered]@{
        commit = $ExpectedSourceCommit.ToLowerInvariant()
        workflowRunId = $ExpectedWorkflowRunId
        workflowRunAttempt = $ExpectedWorkflowRunAttempt
    }
    applicationId = $canonicalAppId
    product = $ExpectedAppTitle
    architecture = 'x64'
    upgradeUuid = $expectedUpgradeUuid
    signed = [bool] $RequireSignature
    publisherThumbprint = if ($RequireSignature) {
        (Get-NormalizedThumbprint $ExpectedPublisherThumbprint).ToLowerInvariant()
    } else { $null }
    rollbackMode = 'verified-current-exe-uninstall-then-previous-exe-reinstall'
    previous = [ordered]@{
        version = $PreviousVersion; build = $PreviousBuild; file = $previousInstaller.File
        bytes = $previousInstaller.Bytes; sha256 = $previousInstaller.Sha256
        bootstrapperMachine = $previousInstaller.BootstrapperMachine
        signatureStatus = $previousInstaller.SignatureStatus
        signerThumbprint = $previousInstaller.SignerThumbprint
        timestamped = $previousInstaller.Timestamped
        artifactManifestSha256 = $previousInstaller.ArtifactManifestSha256
        payloadManifestSha256 = if ($RequireSignature) {
            (Get-FileHash -LiteralPath $PreviousPayloadManifestPath -Algorithm SHA256).Hash.ToLowerInvariant()
        } else { $null }
    }
    current = [ordered]@{
        version = $CurrentVersion; build = $CurrentBuild; file = $currentInstaller.File
        bytes = $currentInstaller.Bytes; sha256 = $currentInstaller.Sha256
        bootstrapperMachine = $currentInstaller.BootstrapperMachine
        signatureStatus = $currentInstaller.SignatureStatus
        signerThumbprint = $currentInstaller.SignerThumbprint
        timestamped = $currentInstaller.Timestamped
        artifactManifestSha256 = $currentInstaller.ArtifactManifestSha256
        payloadManifestSha256 = if ($RequireSignature) {
            (Get-FileHash -LiteralPath $CurrentPayloadManifestPath -Algorithm SHA256).Hash.ToLowerInvariant()
        } else { $null }
    }
    stages = @($stageRecords)
    finalState = [ordered]@{
        relatedProductCount = 0
        shortcutsRemoved = $true
        launcherRemoved = $true
    }
}
$json = $evidence | ConvertTo-Json -Depth 12
$stream = [System.IO.File]::Open(
    $evidencePath, [System.IO.FileMode]::CreateNew,
    [System.IO.FileAccess]::Write, [System.IO.FileShare]::None
)
try {
    $writer = [System.IO.StreamWriter]::new($stream, [System.Text.UTF8Encoding]::new($false))
    try { $writer.Write("$json`n") }
    finally { $writer.Dispose() }
}
finally { $stream.Dispose() }

Write-Output $json
