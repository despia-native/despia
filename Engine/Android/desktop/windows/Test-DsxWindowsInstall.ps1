# Installs a DSX-framework application MSI per-user, exercises the packaged kernel and native window,
# then uninstalls in a finally block. Run only inside an ephemeral Windows VM.

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string] $MsiPath,

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

    [ValidateRange(10, 180)]
    [int] $TimeoutSeconds = 60,

    [switch] $SkipUiSmoke,

    [switch] $RequireSignature,

    [ValidatePattern('^[0-9A-Fa-f]{40}$')]
    [string] $ExpectedPublisherThumbprint,

    [string] $PayloadManifestPath
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
    throw 'The Windows application install smoke must run on Windows.'
}
if ($RequireSignature -and ([string]::IsNullOrWhiteSpace($ExpectedPublisherThumbprint) -or
    [string]::IsNullOrWhiteSpace($PayloadManifestPath))) {
    throw '-RequireSignature requires the expected publisher thumbprint and payload manifest.'
}

$versionParts = @($ExpectedVersion.Split('.') | ForEach-Object { [uint32] $_ })
if ($versionParts[0] -gt 255 -or $versionParts[1] -gt 255 -or $versionParts[2] -gt 65535) {
    throw "MSI version requires major/minor <= 255 and build <= 65535: $ExpectedVersion"
}
$canonicalAppId = $ExpectedAppId.ToLowerInvariant()
$launcherName = "$ExpectedAppTitle.exe"

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

function Invoke-MsiExec {
    param([Parameter(Mandatory = $true)] [string[]] $Arguments)

    $process = Start-Process -FilePath "$env:SystemRoot\System32\msiexec.exe" `
        -ArgumentList $Arguments -Wait -PassThru -NoNewWindow
    if ($process.ExitCode -notin @(0, 1641, 3010)) {
        throw "msiexec failed with exit code $($process.ExitCode): $($Arguments -join ' ')"
    }
}

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class DsxMsiProductProbe {
    [DllImport("msi.dll", CharSet = CharSet.Unicode, SetLastError = false)]
    public static extern int MsiQueryProductState(string productCode);
}
'@

function Get-MsiProductState {
    param([Parameter(Mandatory = $true)] [string] $ProductCode)
    return [DsxMsiProductProbe]::MsiQueryProductState($ProductCode)
}

function Get-MsiProperty {
    param(
        [Parameter(Mandatory = $true)] [string] $LiteralPath,
        [Parameter(Mandatory = $true)] [string] $Name
    )

    if ($Name -notmatch '^[A-Za-z][A-Za-z0-9_]*$') {
        throw "Invalid MSI property name: $Name"
    }
    $installer = New-Object -ComObject WindowsInstaller.Installer
    $database = $null
    $view = $null
    $record = $null
    try {
        $database = $installer.GetType().InvokeMember(
            'OpenDatabase', 'InvokeMethod', $null, $installer, @($LiteralPath, 0)
        )
        $query = "SELECT ``Value`` FROM ``Property`` WHERE ``Property``='$Name'"
        $view = $database.GetType().InvokeMember(
            'OpenView', 'InvokeMethod', $null, $database, @($query)
        )
        [void] $view.GetType().InvokeMember('Execute', 'InvokeMethod', $null, $view, $null)
        $record = $view.GetType().InvokeMember('Fetch', 'InvokeMethod', $null, $view, $null)
        if ($null -eq $record) {
            throw "MSI property is absent: $Name"
        }
        return [string] $record.GetType().InvokeMember('StringData', 'GetProperty', $null, $record, @(1))
    }
    finally {
        if ($null -ne $view) {
            try {
                [void] $view.GetType().InvokeMember('Close', 'InvokeMethod', $null, $view, $null)
            }
            catch {
                # The query has already served its only purpose. Releasing every
                # RCW below is the fail-safe that prevents an MSI file lock.
            }
        }
        foreach ($comObject in @($record, $view, $database, $installer)) {
            if ($null -ne $comObject -and [System.Runtime.InteropServices.Marshal]::IsComObject($comObject)) {
                [void] [System.Runtime.InteropServices.Marshal]::FinalReleaseComObject($comObject)
            }
        }
    }
}

function Invoke-DsxSelfTest {
    param(
        [Parameter(Mandatory = $true)] [string] $Launcher,
        [Parameter(Mandatory = $true)] [string] $OutputPath
    )

    if (Test-Path -LiteralPath $OutputPath) {
        Remove-Item -LiteralPath $OutputPath -Force
    }
    $quotedOutput = '"' + $OutputPath.Replace('"', '\"') + '"'
    $process = Start-Process -FilePath $Launcher `
        -ArgumentList @('--dsx-self-test', '--dsx-self-test-output', $quotedOutput) `
        -PassThru
    if (-not $process.WaitForExit($TimeoutSeconds * 1000)) {
        $process.Kill($true)
        throw 'Packaged DSX self-test timed out.'
    }
    if ($process.ExitCode -ne 0) {
        throw "Packaged DSX self-test exited $($process.ExitCode)."
    }
    if (-not (Test-Path -LiteralPath $OutputPath -PathType Leaf)) {
        throw 'Packaged DSX self-test did not write its result.'
    }

    $result = Get-Content -LiteralPath $OutputPath -Raw | ConvertFrom-Json
    if ($result.schema -ne 'dev.dsx.desktop-self-test/v1' -or
        $result.status -ne 'ok' -or
        $result.os -ne 'windows' -or
        $result.desktop -ne $true) {
        throw "Packaged DSX self-test returned an invalid contract: $($result | ConvertTo-Json -Compress)"
    }
    return $result
}

function Get-NativePeMachine {
    param(
        [Parameter(Mandatory = $true)] [string] $LiteralPath,
        [switch] $AllowNonPe
    )

    $stream = [System.IO.File]::Open(
        $LiteralPath,
        [System.IO.FileMode]::Open,
        [System.IO.FileAccess]::Read,
        [System.IO.FileShare]::Read
    )
    try {
        if ($stream.Length -lt 0x40) {
            if ($AllowNonPe) { return $null }
            throw "Installed native payload is too short: $LiteralPath"
        }
        $reader = [System.IO.BinaryReader]::new($stream)
        try {
            if ($reader.ReadUInt16() -ne 0x5a4d) {
                if ($AllowNonPe) { return $null }
                throw "Installed native payload has no MZ header: $LiteralPath"
            }
            [void] $stream.Seek(0x3c, [System.IO.SeekOrigin]::Begin)
            $peOffset = $reader.ReadUInt32()
            if ($peOffset -lt 0x40 -or $peOffset -gt ($stream.Length - 24)) {
                throw "Installed native payload has an invalid PE offset: $LiteralPath"
            }
            [void] $stream.Seek($peOffset, [System.IO.SeekOrigin]::Begin)
            if ($reader.ReadUInt32() -ne 0x00004550) { throw "Installed native payload has no PE header: $LiteralPath" }
            $machine = $reader.ReadUInt16()
        }
        finally {
            $reader.Dispose()
        }
    }
    finally {
        $stream.Dispose()
    }

    return $machine
}

function Assert-NativeLauncherArchitecture {
    param([Parameter(Mandatory = $true)] [string] $Launcher)

    if ($env:PROCESSOR_ARCHITECTURE -ne 'AMD64') {
        throw "The qualified Windows release lane requires a native AMD64 runner."
    }
    $machine = Get-NativePeMachine -LiteralPath $Launcher
    $expected = 0x8664
    if ($machine -ne $expected) {
        throw ("Installed $ExpectedAppTitle launcher machine 0x{0:x4} does not match runner machine 0x{1:x4}" -f $machine, $expected)
    }
}

function Assert-NativePayloadArchitecture {
    param([Parameter(Mandatory = $true)] [string] $ApplicationRoot)

    $nativeCount = 0
    foreach ($native in @(Get-ChildItem -LiteralPath $ApplicationRoot -Recurse -Force -File)) {
        $machine = Get-NativePeMachine -LiteralPath $native.FullName -AllowNonPe
        if ($null -eq $machine) { continue }
        $nativeCount += 1
        if ($machine -ne 0x8664) {
            throw ("Installed native payload {0} has non-x64 machine 0x{1:x4}" -f $native.FullName, $machine)
        }
    }
    if ($nativeCount -eq 0) { throw "Installed $ExpectedAppTitle payload contains no native binaries." }
}

function Get-NativePayloadFiles {
    param([Parameter(Mandatory = $true)] [System.IO.FileInfo[]] $InstalledFiles)

    return @($InstalledFiles | Where-Object {
        $null -ne (Get-NativePeMachine -LiteralPath $_.FullName -AllowNonPe)
    })
}

function Assert-SignedInstalledPayload {
    param(
        [Parameter(Mandatory = $true)] [string] $ApplicationRoot,
        [Parameter(Mandatory = $true)] [string] $Launcher,
        [Parameter(Mandatory = $true)] [string] $ManifestPath,
        [Parameter(Mandatory = $true)] [string] $PublisherThumbprint,
        [Parameter(Mandatory = $true)] [object] $PackageEvidence
    )

    $manifest = Get-Content -LiteralPath $ManifestPath -Raw | ConvertFrom-Json
    if ($manifest.schema -ne 'dev.dsx.windows-payload/v2' -or
        $null -eq $manifest.packageEvidence -or @($manifest.files).Count -eq 0) {
        throw "Invalid Windows payload manifest for $ExpectedAppTitle ($canonicalAppId)."
    }
    Assert-DsxWindowsPackageEvidenceMatch `
        -Recorded $manifest.packageEvidence -Installed $PackageEvidence
    $root = [System.IO.Path]::GetFullPath($ApplicationRoot)
    $rootPrefix = $root.TrimEnd('\\') + '\\'
    $seen = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    foreach ($record in @($manifest.files)) {
        $relative = [string] $record.path
        if ([string]::IsNullOrWhiteSpace($relative) -or $relative.Contains('\\') -or
            [System.IO.Path]::IsPathRooted($relative) -or $relative.Split('/') -contains '..') {
            throw "Unsafe payload-manifest path: $relative"
        }
        $target = [System.IO.Path]::GetFullPath((Join-Path $root $relative.Replace('/', '\\')))
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
    }

    $installedFiles = @(Get-ChildItem -LiteralPath $root -Recurse -Force -File)
    if ($installedFiles.Count -ne $seen.Count) {
        throw "Installed payload file count $($installedFiles.Count) does not match manifest $($seen.Count)"
    }
    $nativeFiles = @(Get-NativePayloadFiles -InstalledFiles $installedFiles)
    if ($nativeFiles.Count -eq 0) { throw "Installed $ExpectedAppTitle payload contains no native binaries." }
    Assert-NativePayloadArchitecture -ApplicationRoot $root
    foreach ($native in $nativeFiles) {
        $signature = Get-AuthenticodeSignature -LiteralPath $native.FullName
        if ($signature.Status -ne [System.Management.Automation.SignatureStatus]::Valid -or
            $null -eq $signature.SignerCertificate -or $null -eq $signature.TimeStamperCertificate) {
            throw "$($native.FullName) is not validly signed and timestamped"
        }
    }
    $launcherSignature = Get-AuthenticodeSignature -LiteralPath $Launcher
    $actual = $launcherSignature.SignerCertificate.Thumbprint.Replace(' ', '').ToUpperInvariant()
    $expected = $PublisherThumbprint.Replace(' ', '').ToUpperInvariant()
    if ($actual -cne $expected) {
        throw "Installed $ExpectedAppTitle launcher signer mismatch: $actual"
    }
}

function Invoke-DsxUiSmoke {
    param([Parameter(Mandatory = $true)] [string] $Launcher)

    if (-not ('DsxWindowProbe' -as [type])) {
        Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class DsxWindowProbe {
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
    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
    // A jpackage app's window is not reliably reported by Process.MainWindowHandle
    // (the native launcher's process/window association is opaque to .NET), so enumerate
    // top-level windows — but BOUND TO THE PROCESS UNDER TEST: the window must belong to
    // one of the allowed PIDs (the launcher + its descendants). Title-prefix alone let ANY
    // DSX-titled window on the runner desktop satisfy the smoke — a leftover from a prior
    // smoke (this lifecycle runs two with the same title), or the QA demo whose
    // "DSX Desktop QA" title StartsWith-matches the default "DSX" — so a launcher that
    // started but never painted still passed. The lane must prove THIS binary opened a
    // window, not that one exists.
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
                throw "$ExpectedAppTitle UI process exited before opening a window (exit $($process.ExitCode))."
            }
            $allowedPids = Get-DsxProcessTreePids -RootProcessId $process.Id
            $handle = [DsxWindowProbe]::FindVisibleWindowByTitlePrefix($ExpectedAppTitle, $allowedPids)
            if ($handle -ne [IntPtr]::Zero) { break }
            Start-Sleep -Milliseconds 250
        }
        if ($handle -eq [IntPtr]::Zero) {
            throw "$ExpectedAppTitle did not create a visible top-level Windows window before the deadline."
        }
        $rect = [DsxWindowProbe+RECT]::new()
        if (-not [DsxWindowProbe]::GetWindowRect($handle, [ref] $rect)) {
            throw "Could not read the $ExpectedAppTitle top-level window bounds."
        }
        if (($rect.Right - $rect.Left) -lt 320 -or ($rect.Bottom - $rect.Top) -lt 240) {
            throw "$ExpectedAppTitle top-level window is too small: $($rect.Right - $rect.Left)x$($rect.Bottom - $rect.Top)"
        }
    }
    finally {
        # MainWindowHandle is unreliable for this launcher, so CloseMainWindow cannot
        # ask the app to exit. Terminate the launcher tree and WAIT for it, so the app
        # releases the jars it loaded (Windows keeps them locked while the process
        # lives) before any later install/repair stage opens them.
        if (-not $process.HasExited) { $process.Kill($true) }
        [void] $process.WaitForExit(10000)
        $process.Dispose()
    }
}

$msi = (Get-Item -LiteralPath $MsiPath -Force).FullName
if ([System.IO.Path]::GetExtension($msi) -ine '.msi') {
    throw "Expected an MSI artifact: $msi"
}

$productCode = Get-MsiProperty -LiteralPath $msi -Name 'ProductCode'
$productVersion = Get-MsiProperty -LiteralPath $msi -Name 'ProductVersion'
$productName = Get-MsiProperty -LiteralPath $msi -Name 'ProductName'
$manufacturer = Get-MsiProperty -LiteralPath $msi -Name 'Manufacturer'
$upgradeCode = Get-MsiProperty -LiteralPath $msi -Name 'UpgradeCode'
if ($productCode -notmatch '^\{[0-9A-Fa-f-]{36}\}$') {
    throw "Invalid MSI ProductCode: $productCode"
}
if ($productVersion -ne $ExpectedVersion) {
    throw "MSI ProductVersion $productVersion does not match $ExpectedVersion"
}
if ($productName -cne $ExpectedAppTitle -or $manufacturer -cne 'DSX' -or
    $upgradeCode.Trim([char[]] @('{', '}')) -ine $expectedUpgradeUuid) {
    throw "Unexpected MSI identity: ProductName=$productName Manufacturer=$manufacturer UpgradeCode=$upgradeCode"
}

# Never repair, replace, or remove a product registration that predates this
# ephemeral test. INSTALLSTATE_UNKNOWN (-1) is the only safe starting state.
$initialProductState = Get-MsiProductState -ProductCode $productCode
if ($initialProductState -ne -1) {
    throw "Refusing to test MSI ProductCode $productCode because it is already registered (state $initialProductState)."
}

$testRoot = Join-Path $env:RUNNER_TEMP "dsx-windows-install-$([Guid]::NewGuid().ToString('N'))"
$installRoot = Join-Path $testRoot 'app'
$msiLog = Join-Path $testRoot 'install.log'
$selfTestOutput = Join-Path $testRoot 'self-test.json'
[System.IO.Directory]::CreateDirectory($installRoot) | Out-Null
$installAttempted = $false

try {
    $installAttempted = $true
    Invoke-MsiExec -Arguments @(
        '/i', "`"$msi`"", '/qn', '/norestart',
        'ALLUSERS=2', 'MSIINSTALLPERUSER=1',
        "INSTALLDIR=`"$installRoot`"", '/l*v', "`"$msiLog`""
    )
    $installedProductState = Get-MsiProductState -ProductCode $productCode
    if ($installedProductState -notin @(3, 5)) {
        throw "Windows Installer did not register $productCode as a local/default product (state $installedProductState)."
    }

    $launchers = @(Get-ChildItem -LiteralPath $installRoot -Recurse -File -Filter $launcherName)
    if ($launchers.Count -ne 1) {
        throw "Expected exactly one installed $launcherName, found $($launchers.Count) under $installRoot"
    }
    $launcher = $launchers[0].FullName
    Assert-NativeLauncherArchitecture -Launcher $launcher
    $packageEvidence = Get-DsxWindowsPackageEvidence `
        -ApplicationRoot ([System.IO.Path]::GetDirectoryName($launcher)) `
        -Launcher $launcher `
        -ExpectedVersion $ExpectedVersion `
        -ExpectedAppId $canonicalAppId `
        -ExpectedAppTitle $ExpectedAppTitle `
        -ExpectedBuild $ExpectedBuild `
        -ExpectedEntry $ExpectedEntry `
        -ExpectedAssets $ExpectedAssets
    Assert-NativePayloadArchitecture -ApplicationRoot ([System.IO.Path]::GetDirectoryName($launcher))
    if ($RequireSignature) {
        Assert-SignedInstalledPayload `
            -ApplicationRoot ([System.IO.Path]::GetDirectoryName($launcher)) `
            -Launcher $launcher `
            -ManifestPath $PayloadManifestPath `
            -PublisherThumbprint $ExpectedPublisherThumbprint `
            -PackageEvidence $packageEvidence
    }

    $first = Invoke-DsxSelfTest -Launcher $launcher -OutputPath $selfTestOutput

    # Exercise Windows Installer's repair/update path. This is deliberately an
    # in-place reinstall; cross-version upgrade remains a release-candidate test
    # using the preceding signed MSI.
    Invoke-MsiExec -Arguments @(
        '/i', "`"$msi`"", '/qn', '/norestart',
        'REINSTALL=ALL', 'REINSTALLMODE=vomus',
        "INSTALLDIR=`"$installRoot`"", '/l*v', "`"$msiLog`""
    )
    $repairedProductState = Get-MsiProductState -ProductCode $productCode
    if ($repairedProductState -notin @(3, 5)) {
        throw "Windows Installer repair left $productCode in an unexpected state $repairedProductState."
    }
    $repairedPackageEvidence = Get-DsxWindowsPackageEvidence `
        -ApplicationRoot ([System.IO.Path]::GetDirectoryName($launcher)) `
        -Launcher $launcher `
        -ExpectedVersion $ExpectedVersion `
        -ExpectedAppId $canonicalAppId `
        -ExpectedAppTitle $ExpectedAppTitle `
        -ExpectedBuild $ExpectedBuild `
        -ExpectedEntry $ExpectedEntry `
        -ExpectedAssets $ExpectedAssets
    Assert-DsxWindowsPackageEvidenceMatch `
        -Recorded $packageEvidence -Installed $repairedPackageEvidence
    Assert-NativePayloadArchitecture -ApplicationRoot ([System.IO.Path]::GetDirectoryName($launcher))
    if ($RequireSignature) {
        Assert-SignedInstalledPayload `
            -ApplicationRoot ([System.IO.Path]::GetDirectoryName($launcher)) `
            -Launcher $launcher `
            -ManifestPath $PayloadManifestPath `
            -PublisherThumbprint $ExpectedPublisherThumbprint `
            -PackageEvidence $repairedPackageEvidence
    }
    $second = Invoke-DsxSelfTest -Launcher $launcher -OutputPath $selfTestOutput

    if (-not $SkipUiSmoke) {
        Invoke-DsxUiSmoke -Launcher $launcher
    }

    [ordered]@{
        schema = 'dev.dsx.windows-install-smoke/v1'
        status = 'ok'
        applicationId = $packageEvidence.applicationId
        product = $packageEvidence.product
        productCode = $productCode
        version = $packageEvidence.version
        build = $packageEvidence.build
        packageEvidence = $packageEvidence
        selfTest = $first
        repairedSelfTest = $second
        uiSmoke = (-not $SkipUiSmoke)
    } | ConvertTo-Json -Depth 8
}
finally {
    $cleanupFailure = $null
    if ($installAttempted) {
        try {
            if ((Get-MsiProductState -ProductCode $productCode) -ne -1) {
                Invoke-MsiExec -Arguments @('/x', $productCode, '/qn', '/norestart')
            }
            $finalProductState = Get-MsiProductState -ProductCode $productCode
            if ($finalProductState -ne -1) {
                throw "Windows Installer left ProductCode $productCode registered after uninstall (state $finalProductState)."
            }
            if (Test-Path -LiteralPath $installRoot) {
                $remainingLaunchers = @(Get-ChildItem -LiteralPath $installRoot -Recurse -File -Filter $launcherName)
                if ($remainingLaunchers.Count -ne 0) {
                    throw "Windows Installer uninstall left the $ExpectedAppTitle launcher installed."
                }
            }
        }
        catch {
            $cleanupFailure = "$ExpectedAppTitle uninstall failed: $_"
        }
    }
    try {
        if (Test-Path -LiteralPath $testRoot) {
            Remove-Item -LiteralPath $testRoot -Recurse -Force
        }
    }
    catch {
        if ($null -eq $cleanupFailure) {
            $cleanupFailure = "$ExpectedAppTitle test-root cleanup failed: $_"
        }
    }
    if ($null -ne $cleanupFailure) {
        throw $cleanupFailure
    }
}
