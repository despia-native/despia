# DSX-framework Windows desktop release artifact verifier.
#
# This is intentionally dependency-free and runs on a stock GitHub-hosted
# Windows image. It validates the two jpackage containers before anything is
# installed and emits a deterministic SHA-256 manifest for release provenance.

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string[]] $Artifact,

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

    [switch] $RequireSignature,

    [ValidatePattern('^[0-9A-Fa-f]{40}$')]
    [string] $ExpectedPublisherThumbprint,

    [string] $ManifestOutput
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

if (-not $IsWindows) {
    throw 'Windows application artifacts must be verified on a Windows host.'
}

$versionParts = @($ExpectedVersion.Split('.') | ForEach-Object { [uint32] $_ })
if ($versionParts[0] -gt 255 -or $versionParts[1] -gt 255 -or $versionParts[2] -gt 65535) {
    throw "MSI version requires major/minor <= 255 and build <= 65535: $ExpectedVersion"
}
$canonicalAppId = $ExpectedAppId.ToLowerInvariant()
if ($ExpectedAppTitle.EndsWith('.') -or
    $ExpectedAppTitle -match '^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\..*)?$') {
    throw 'ExpectedAppTitle is not a portable Windows product/launcher name.'
}

function Read-ExactBytes {
    param(
        [Parameter(Mandatory = $true)] [string] $LiteralPath,
        [Parameter(Mandatory = $true)] [int] $Count,
        [long] $Offset = 0
    )

    $stream = [System.IO.File]::Open(
        $LiteralPath,
        [System.IO.FileMode]::Open,
        [System.IO.FileAccess]::Read,
        [System.IO.FileShare]::Read
    )
    try {
        if ($Offset -gt $stream.Length -or $Count -gt ($stream.Length - $Offset)) {
            throw "Artifact is too short for header read: $LiteralPath"
        }
        [void] $stream.Seek($Offset, [System.IO.SeekOrigin]::Begin)
        $bytes = [byte[]]::new($Count)
        $read = $stream.Read($bytes, 0, $Count)
        if ($read -ne $Count) {
            throw "Short artifact header read ($read/$Count): $LiteralPath"
        }
        return $bytes
    }
    finally {
        $stream.Dispose()
    }
}

function Assert-ByteSequence {
    param(
        [Parameter(Mandatory = $true)] [byte[]] $Actual,
        [Parameter(Mandatory = $true)] [byte[]] $Expected,
        [Parameter(Mandatory = $true)] [string] $Label
    )

    if ($Actual.Length -ne $Expected.Length) {
        throw "$Label length mismatch"
    }
    for ($index = 0; $index -lt $Expected.Length; $index += 1) {
        if ($Actual[$index] -ne $Expected[$index]) {
            throw "$Label magic mismatch at byte $index"
        }
    }
}

function Assert-PortableExecutable {
    param([Parameter(Mandatory = $true)] [System.IO.FileInfo] $File)

    Assert-ByteSequence `
        -Actual (Read-ExactBytes -LiteralPath $File.FullName -Count 2) `
        -Expected ([byte[]](0x4d, 0x5a)) `
        -Label "$($File.Name) DOS"

    $offsetBytes = Read-ExactBytes -LiteralPath $File.FullName -Count 4 -Offset 0x3c
    $peOffset = [System.BitConverter]::ToUInt32($offsetBytes, 0)
    if ($peOffset -lt 0x40 -or $peOffset -gt ($File.Length - 24)) {
        throw "$($File.Name) has an invalid PE header offset: $peOffset"
    }

    Assert-ByteSequence `
        -Actual (Read-ExactBytes -LiteralPath $File.FullName -Count 4 -Offset $peOffset) `
        -Expected ([byte[]](0x50, 0x45, 0x00, 0x00)) `
        -Label "$($File.Name) PE"

    $machine = [System.BitConverter]::ToUInt16(
        (Read-ExactBytes -LiteralPath $File.FullName -Count 2 -Offset ($peOffset + 4)),
        0
    )
    # jpackage's WiX EXE format may use the WiX i386 bootstrapper even when its
    # MSI and complete installed payload are x64. Keep only that compatibility
    # exception; ARM64 is a different product architecture and is not qualified.
    if ($machine -eq 0x014c) { return 'wix-bootstrapper-i386' }
    if ($machine -eq 0x8664) { return 'pe-x64' }
    if ($machine -eq 0xaa64) {
        throw "$($File.Name) is ARM64, but this release lane is x64-only."
    }
    throw ('{0} has unsupported PE machine 0x{1:x4}' -f $File.Name, $machine)
}

function Assert-MsiContainer {
    param([Parameter(Mandatory = $true)] [System.IO.FileInfo] $File)

    Assert-ByteSequence `
        -Actual (Read-ExactBytes -LiteralPath $File.FullName -Count 8) `
        -Expected ([byte[]](0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1)) `
        -Label "$($File.Name) MSI compound-file"
    return 'windows-installer'
}

function Get-ValidatedSignature {
    param([Parameter(Mandatory = $true)] [System.IO.FileInfo] $File)

    $signature = Get-AuthenticodeSignature -LiteralPath $File.FullName
    if ($RequireSignature -and $signature.Status -ne [System.Management.Automation.SignatureStatus]::Valid) {
        throw "$($File.Name) must have a valid Authenticode signature; status=$($signature.Status)"
    }

    if (-not [string]::IsNullOrWhiteSpace($ExpectedPublisherThumbprint)) {
        if ($signature.Status -ne [System.Management.Automation.SignatureStatus]::Valid -or $null -eq $signature.SignerCertificate) {
            throw "$($File.Name) cannot be matched to the expected publisher without a valid signature"
        }
        $actualThumbprint = $signature.SignerCertificate.Thumbprint.Replace(' ', '').ToUpperInvariant()
        $expectedThumbprint = $ExpectedPublisherThumbprint.Replace(' ', '').ToUpperInvariant()
        if ($actualThumbprint -cne $expectedThumbprint) {
            throw "$($File.Name) signer thumbprint mismatch: $actualThumbprint"
        }
    }

    if ($signature.Status -eq [System.Management.Automation.SignatureStatus]::Valid) {
        $codeSigningOid = '1.3.6.1.5.5.7.3.3'
        $hasCodeSigningEku = @($signature.SignerCertificate.EnhancedKeyUsageList) |
            Where-Object { $_.ObjectId.Value -eq $codeSigningOid }
        if ($hasCodeSigningEku.Count -eq 0) {
            throw "$($File.Name) signer certificate lacks the Code Signing EKU"
        }
        if ($signature.SignerCertificate.NotAfter.ToUniversalTime() -le [DateTime]::UtcNow) {
            throw "$($File.Name) signer certificate is expired"
        }
        if ($RequireSignature -and $null -eq $signature.TimeStamperCertificate) {
            throw "$($File.Name) signature is not RFC 3161 timestamped"
        }
    }

    return $signature
}

if ($Artifact.Count -ne 2) {
    throw 'Exactly one MSI and one EXE artifact are required.'
}

$resolved = @($Artifact | ForEach-Object {
    $item = Get-Item -LiteralPath $_ -Force
    if ($item.PSIsContainer) {
        throw "Artifact is a directory: $($item.FullName)"
    }
    if ($item.LinkType) {
        throw "Artifact must not be a link or reparse-point alias: $($item.FullName)"
    }
    if ($item.Length -lt 65536) {
        throw "Artifact is implausibly small ($($item.Length) bytes): $($item.FullName)"
    }
    $item
})

$canonicalPaths = @($resolved | ForEach-Object { $_.FullName.ToUpperInvariant() })
# Sort-Object -Unique collapses to a scalar when it yields a single value; wrap in
# @() so .Count is always the array count and never a missing member on a scalar
# (Set-StrictMode -Version Latest rejects .Count on a bare [string]).
if (@($canonicalPaths | Sort-Object -Unique).Count -ne $resolved.Count) {
    throw 'Artifact paths must be distinct.'
}

$extensions = @($resolved | ForEach-Object { $_.Extension.ToLowerInvariant() } | Sort-Object)
if (($extensions -join ',') -ne '.exe,.msi') {
    throw "Required artifact extensions are .exe and .msi; got $($extensions -join ', ')"
}

$expectedSuffix = "-$ExpectedVersion"
$baseNames = @($resolved | ForEach-Object { $_.BaseName })
$expectedBaseName = "$ExpectedAppTitle$expectedSuffix"
# The MSI and EXE deliberately share one base name, so Sort-Object -Unique yields a
# single scalar here; @() keeps .Count valid (a bare [string] has no .Count under
# Set-StrictMode -Version Latest, which is exactly the shared-name success case).
if (@($baseNames | Sort-Object -Unique).Count -ne 1 -or
    -not $baseNames[0].Equals($expectedBaseName, [StringComparison]::OrdinalIgnoreCase)) {
    throw "MSI and EXE must both use the expected base name $expectedBaseName"
}

$records = @($resolved | Sort-Object Extension | ForEach-Object {
    $container = if ($_.Extension -ieq '.exe') {
        Assert-PortableExecutable -File $_
    }
    else {
        Assert-MsiContainer -File $_
    }
    $signature = Get-ValidatedSignature -File $_
    $hash = Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256

    [ordered]@{
        file = $_.Name
        bytes = $_.Length
        sha256 = $hash.Hash.ToLowerInvariant()
        container = $container
        signatureStatus = $signature.Status.ToString()
        signerSubject = if ($null -ne $signature.SignerCertificate) { $signature.SignerCertificate.Subject } else { $null }
        signerThumbprint = if ($null -ne $signature.SignerCertificate) { $signature.SignerCertificate.Thumbprint.ToLowerInvariant() } else { $null }
        timestamped = ($null -ne $signature.TimeStamperCertificate)
    }
})

$manifest = [ordered]@{
    schema = 'dev.dsx.windows-artifacts/v1'
    applicationId = $canonicalAppId
    product = $ExpectedAppTitle
    version = $ExpectedVersion
    build = $ExpectedBuild
    entry = $ExpectedEntry
    assets = $ExpectedAssets
    signed = [bool] $RequireSignature
    artifacts = $records
}
$json = $manifest | ConvertTo-Json -Depth 6

if (-not [string]::IsNullOrWhiteSpace($ManifestOutput)) {
    $manifestPath = [System.IO.Path]::GetFullPath($ManifestOutput)
    $parent = [System.IO.Path]::GetDirectoryName($manifestPath)
    if (-not [string]::IsNullOrWhiteSpace($parent)) {
        [System.IO.Directory]::CreateDirectory($parent) | Out-Null
    }
    [System.IO.File]::WriteAllText($manifestPath, "$json`n", [System.Text.UTF8Encoding]::new($false))
}

Write-Output $json
