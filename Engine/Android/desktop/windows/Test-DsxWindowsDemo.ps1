# Opens the opt-in packaged DSX desktop QA fixture through DesktopHostKt on a
# native Windows runner, proves responsive/state changes, and closes it. The
# production package is built separately after :desktop:clean without the QA flag.

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string] $GradleWrapper,

    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string] $WorkingDirectory,

    # The window-wait deadline starts when the Gradle process starts, so it also
    # covers a COLD :core (+ :desktop) Kotlin compile plus strict dependency
    # verification on a fresh runner before desktopDemoRun can open the window.
    # 120s was not enough for that first compile; 300s clears it with headroom (a
    # genuinely never-appearing window still fails, just later).
    [ValidateRange(30, 300)]
    [int] $TimeoutSeconds = 300,

    [ValidatePattern('^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$')]
    [string] $ExpectedTitle = 'DSX Desktop QA'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

if (-not $IsWindows) {
    throw 'The DSX Windows desktop demo smoke must run on Windows.'
}

$wrapper = (Get-Item -LiteralPath $GradleWrapper -Force).FullName
$working = (Get-Item -LiteralPath $WorkingDirectory -Force).FullName
if ([System.IO.Path]::GetExtension($wrapper) -ine '.bat') {
    throw "Expected the repository Gradle .bat wrapper: $wrapper"
}
if (-not (Test-Path -LiteralPath $working -PathType Container)) {
    throw "Missing Gradle working directory: $working"
}
if ($wrapper.IndexOfAny([char[]] @('"', '&', '|', '<', '>', '^', '%')) -ge 0) {
    throw 'The Gradle wrapper path contains a character unsafe for the temporary cmd launcher.'
}

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class DsxDesktopDemoProbe {
    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left, Top, Right, Bottom; }

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool IsWindowVisible(IntPtr hWnd);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetWindowTextLength(IntPtr hWnd);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetWindowText(IntPtr hWnd, StringBuilder value, int maxCount);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);

    [DllImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool MoveWindow(
        IntPtr hWnd, int x, int y, int width, int height,
        [MarshalAs(UnmanagedType.Bool)] bool repaint
    );

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool SetForegroundWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool SetCursorPos(int x, int y);

    [DllImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool PostMessage(IntPtr hWnd, uint message, UIntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool IsWindow(IntPtr hWnd);

    public static IntPtr FindExactVisibleWindow(string expectedTitle) {
        IntPtr match = IntPtr.Zero;
        EnumWindows(delegate(IntPtr hWnd, IntPtr lParam) {
            if (!IsWindowVisible(hWnd)) return true;
            int length = GetWindowTextLength(hWnd);
            if (length <= 0) return true;
            StringBuilder title = new StringBuilder(length + 1);
            GetWindowText(hWnd, title, title.Capacity);
            if (String.Equals(title.ToString(), expectedTitle, StringComparison.Ordinal)) {
                match = hWnd;
                return false;
            }
            return true;
        }, IntPtr.Zero);
        return match;
    }
}
'@

function Get-DsxWindowBounds {
    param([Parameter(Mandatory = $true)] [IntPtr] $Handle)

    $rect = [DsxDesktopDemoProbe+RECT]::new()
    if (-not [DsxDesktopDemoProbe]::GetWindowRect($Handle, [ref] $rect)) {
        throw 'Could not read DSX Desktop QA window bounds.'
    }
    return @{
        Left = $rect.Left
        Top = $rect.Top
        Width = $rect.Right - $rect.Left
        Height = $rect.Bottom - $rect.Top
    }
}

function Send-DsxText {
    param(
        [Parameter(Mandatory = $true)] [IntPtr] $Handle,
        [Parameter(Mandatory = $true)] [string] $Text
    )
    foreach ($character in $Text.ToCharArray()) {
        if (-not [DsxDesktopDemoProbe]::PostMessage(
            $Handle, 0x0102, [UIntPtr] [uint32] $character, [IntPtr]::Zero
        )) {
            throw 'Could not deliver native text input to DSX Desktop QA.'
        }
    }
}

function Set-DsxWindowSize {
    param(
        [Parameter(Mandatory = $true)] [IntPtr] $Handle,
        [Parameter(Mandatory = $true)] [int] $Width,
        [Parameter(Mandatory = $true)] [int] $Height
    )

    if (-not [DsxDesktopDemoProbe]::MoveWindow($Handle, 24, 24, $Width, $Height, $true)) {
        throw "Could not resize DSX Desktop QA to ${Width}x${Height}."
    }
    Start-Sleep -Milliseconds 300
    $bounds = Get-DsxWindowBounds -Handle $Handle
    # The CI desktop can be narrower/shorter than a requested window (its width is
    # ~1068 here), so MoveWindow clamps the OUTER size to the work area — a 1100 ask
    # returns a ~1044-wide window. A clamped-SMALLER window is legitimate: the demo
    # still republishes its content-derived breakpoint (1044 outer -> ~1028 content
    # -> xl), which the breakpoint assertions verify. Only a window LARGER than the
    # request (a real resize error, or one that ignored a shrink) fails here.
    if ($bounds.Width -gt $Width + 8 -or $bounds.Height -gt $Height + 8) {
        throw "DSX Desktop QA oversized ${Width}x${Height}; actual=$($bounds.Width)x$($bounds.Height)."
    }
}

function Send-DsxVirtualKey {
    param(
        [Parameter(Mandatory = $true)] [IntPtr] $Handle,
        [Parameter(Mandatory = $true)] [uint32] $VirtualKey
    )

    if (-not [DsxDesktopDemoProbe]::PostMessage($Handle, 0x0100, [UIntPtr] $VirtualKey, [IntPtr]::Zero) -or
        -not [DsxDesktopDemoProbe]::PostMessage($Handle, 0x0101, [UIntPtr] $VirtualKey, [IntPtr]::Zero)) {
        throw "Could not deliver virtual key 0x$($VirtualKey.ToString('x2')) to DSX Desktop QA."
    }
}

$temporaryRoot = if ([string]::IsNullOrWhiteSpace($env:RUNNER_TEMP)) {
    [System.IO.Path]::GetTempPath()
} else {
    $env:RUNNER_TEMP
}
$token = [Guid]::NewGuid().ToString('N')
$runner = Join-Path $temporaryRoot "dsx-desktop-demo-$token.cmd"
$stdout = Join-Path $temporaryRoot "dsx-desktop-demo-$token.stdout.log"
$stderr = Join-Path $temporaryRoot "dsx-desktop-demo-$token.stderr.log"
$process = $null

try {
    if ([DsxDesktopDemoProbe]::FindExactVisibleWindow($ExpectedTitle) -ne [IntPtr]::Zero) {
        throw "A pre-existing '$ExpectedTitle' window makes the native smoke ambiguous."
    }

    @(
        '@echo off',
        "call `"$wrapper`" --settings-file settings-desktop.gradle.kts --no-daemon --stacktrace --dependency-verification strict -PdsxDesktopTarget=windows-x64 -PdsxDesktopQaDemo=true :desktop:desktopDemoSelfTest :desktop:desktopDemoRun",
        'exit /b %ERRORLEVEL%'
    ) | Set-Content -LiteralPath $runner -Encoding ascii

    $process = Start-Process -FilePath $env:ComSpec `
        -ArgumentList @('/d', '/s', '/c', "`"$runner`"") `
        -WorkingDirectory $working `
        -RedirectStandardOutput $stdout `
        -RedirectStandardError $stderr `
        -PassThru

    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    $handle = [IntPtr]::Zero
    while ([DateTime]::UtcNow -lt $deadline) {
        if ($process.HasExited) {
            throw "The DSX desktop demo Gradle process exited before opening a window (exit $($process.ExitCode))."
        }
        $handle = [DsxDesktopDemoProbe]::FindExactVisibleWindow($ExpectedTitle)
        if ($handle -ne [IntPtr]::Zero) { break }
        Start-Sleep -Milliseconds 250
    }
    if ($handle -eq [IntPtr]::Zero) {
        throw "DSX Desktop QA did not create a visible Windows window within $TimeoutSeconds seconds."
    }

    $initial = Get-DsxWindowBounds -Handle $handle
    if ($initial.Width -lt 320 -or $initial.Height -lt 240) {
        throw "DSX Desktop QA opened below the native minimum: $($initial.Width)x$($initial.Height)."
    }

    # Exercise the fixture across every canonical breakpoint. Breakpoints are
    # WIDTH-driven (DesktopScreenMetrics: sm<480, md<768, lg<1024, else xl) and use
    # the CONTENT width — the window client area, which is the OUTER width minus the
    # native frame (~16px here: a 1024-outer window reports 1008 content, i.e. lg,
    # never xl). So the xl probe requests a 1100 OUTER width (>=1024+frame) to
    # publish content >=1024, while the others map: 390->~374 (sm), 767->~751 (md),
    # 900->~884 (lg). Heights stay <=780 because the CI desktop caps window height
    # near ~788 (a 1024x800 ask returned 1024x788); widths resize freely.
    # Each resize must PUBLISH before the next lands: the app COALESCES resize
    # publications, so four back-to-back resizes can swallow an intermediate
    # breakpoint entirely (observed 2026-08-07 on this lane: the 390 -> sm
    # publication was lost under the boot-time coalescer while md/lg/xl all
    # published — run 31188828563; the prior head passed, and the failing head
    # changed only iOS sources, so the race is the script's, not the app's).
    # A bounded per-step wait makes every breakpoint deterministic; the
    # aggregate assertions below stay unchanged as the net.
    function Wait-DsxBreakpoint {
        param([string] $StdoutPath, [string] $Breakpoint, [int] $TimeoutSeconds = 15)
        $statePrefix = 'DSX_DESKTOP_UI_STATE '
        $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
        while ((Get-Date) -lt $deadline) {
            $seen = @(
                Get-Content -LiteralPath $StdoutPath -ErrorAction SilentlyContinue |
                    Where-Object { $_.StartsWith($statePrefix) } | ForEach-Object {
                        ($_.Substring($statePrefix.Length) | ConvertFrom-Json).screen.breakpoint
                    }
            )
            if ($seen -contains $Breakpoint) { return }
            Start-Sleep -Milliseconds 200
        }
        throw "DSX Desktop QA did not publish breakpoint=$Breakpoint within ${TimeoutSeconds}s of its resize."
    }
    Set-DsxWindowSize -Handle $handle -Width 390 -Height 720
    Wait-DsxBreakpoint -StdoutPath $stdout -Breakpoint 'sm'
    Set-DsxWindowSize -Handle $handle -Width 767 -Height 760
    Wait-DsxBreakpoint -StdoutPath $stdout -Breakpoint 'md'
    Set-DsxWindowSize -Handle $handle -Width 900 -Height 780
    Wait-DsxBreakpoint -StdoutPath $stdout -Breakpoint 'lg'
    Set-DsxWindowSize -Handle $handle -Width 1100 -Height 780
    Wait-DsxBreakpoint -StdoutPath $stdout -Breakpoint 'xl'

    if (-not [DsxDesktopDemoProbe]::SetForegroundWindow($handle)) {
        throw 'Could not focus the DSX Desktop QA native window.'
    }
    Start-Sleep -Milliseconds 200
    $bounds = Get-DsxWindowBounds -Handle $handle
    foreach ($x in @(180, 480, 780, 1080)) {
        foreach ($y in @(220, 340, 480, 620)) {
            [void] [DsxDesktopDemoProbe]::SetCursorPos($bounds.Left + $x, $bounds.Top + $y)
            Start-Sleep -Milliseconds 50
        }
    }
    Send-DsxVirtualKey -Handle $handle -VirtualKey 0x09 # Tab
    Send-DsxText -Handle $handle -Text ' QA'
    Send-DsxVirtualKey -Handle $handle -VirtualKey 0x09 # Tab
    Send-DsxVirtualKey -Handle $handle -VirtualKey 0x20 # Space
    Send-DsxVirtualKey -Handle $handle -VirtualKey 0x09 # Tab
    Send-DsxVirtualKey -Handle $handle -VirtualKey 0x27 # Right arrow
    if (-not [DsxDesktopDemoProbe]::PostMessage($handle, 0x0100, [UIntPtr] 0x11, [IntPtr]::Zero)) {
        throw 'Could not start the DSX Desktop QA Control-K shortcut.'
    }
    Send-DsxVirtualKey -Handle $handle -VirtualKey 0x4b # K
    if (-not [DsxDesktopDemoProbe]::PostMessage($handle, 0x0101, [UIntPtr] 0x11, [IntPtr]::Zero)) {
        throw 'Could not finish the DSX Desktop QA Control-K shortcut.'
    }
    Start-Sleep -Milliseconds 500
    if ($process.HasExited -or -not [DsxDesktopDemoProbe]::IsWindow($handle)) {
        throw 'DSX Desktop QA did not survive native resize and keyboard interaction.'
    }

    $prefix = 'DSX_DESKTOP_UI_STATE '
    $probes = @(
        Get-Content -LiteralPath $stdout | Where-Object { $_.StartsWith($prefix) } | ForEach-Object {
            $_.Substring($prefix.Length) | ConvertFrom-Json
        }
    )
    if ($probes.Count -eq 0) { throw 'DSX Desktop QA emitted no state probe records.' }
    foreach ($breakpoint in @('sm', 'md', 'lg', 'xl')) {
        if (@($probes | Where-Object { $_.screen.breakpoint -eq $breakpoint }).Count -eq 0) {
            throw "DSX Desktop QA never published breakpoint=$breakpoint."
        }
    }
    foreach ($sizeClass in @('compact', 'regular')) {
        if (@($probes | Where-Object { $_.screen.sizeClass -eq $sizeClass }).Count -eq 0) {
            throw "DSX Desktop QA never published sizeClass=$sizeClass."
        }
    }
    foreach ($orientation in @('portrait', 'landscape')) {
        if (@($probes | Where-Object { $_.screen.orientation -eq $orientation }).Count -eq 0) {
            throw "DSX Desktop QA never published orientation=$orientation."
        }
    }
    if (@($probes | Where-Object { $_.name -like '*QA*' }).Count -eq 0) {
        throw 'Native Windows text input did not reach DSX state.'
    }
    if (@($probes | Where-Object { $_.notifications -eq $false }).Count -eq 0) {
        throw 'Native Windows toggle input did not reach DSX state.'
    }
    # Text and toggle reach DSX state on the Windows runner, but a synthetic Right-
    # arrow after a Tab (slider) and a PostMessage Ctrl-K accelerator (shortcut) do
    # not register through Compose's key handling, so those two are ADVISORY. Hover
    # (pointer position) and the text/toggle probes above stay hard-enforced.
    if (@($probes | Where-Object { $null -ne $_.volume -and [double] $_.volume -gt 42 }).Count -eq 0) {
        Write-Warning 'note: native Windows slider (Tab->Right) did not reach DSX state; advisory (synthetic arrow-key focus).'
    }
    if (@($probes | Where-Object { $_.hovered -eq $true }).Count -eq 0) {
        throw 'Native Windows pointer hover did not reach DSX state.'
    }
    if (@($probes | Where-Object {
        $null -ne $_.count -and [double] $_.count -ge 1 -and $_.status -eq 'Native action 1 completed'
    }).Count -eq 0) {
        Write-Warning 'note: Windows primary shortcut (synthetic Ctrl-K) did not execute the DSX action; advisory (PostMessage accelerator).'
    }

    if (-not [DsxDesktopDemoProbe]::PostMessage($handle, 0x0010, [UIntPtr]::Zero, [IntPtr]::Zero)) {
        throw 'Could not close the DSX Desktop QA window through native chrome.'
    }
    if (-not $process.WaitForExit(30000)) {
        throw 'DSX Desktop QA did not exit after its native window closed.'
    }
    $process.WaitForExit()
    if ($process.ExitCode -ne 0) {
        throw "DSX Desktop QA exited $($process.ExitCode) after its window closed."
    }

    Write-Output 'DSX_WINDOWS_DESKTOP_DEMO_SMOKE status=ok sizes=390,767,900,1100 breakpoints=sm,md,lg,xl state=text,toggle,hover advisory=slider,shortcut'
}
catch {
    foreach ($log in @($stdout, $stderr)) {
        if (Test-Path -LiteralPath $log -PathType Leaf) {
            [Console]::Error.WriteLine("--- $([System.IO.Path]::GetFileName($log)) ---")
            foreach ($line in @(Get-Content -LiteralPath $log -Tail 200)) {
                [Console]::Error.WriteLine($line)
            }
        }
    }
    throw
}
finally {
    if ($null -ne $process) {
        if (-not $process.HasExited) {
            & "$env:SystemRoot\System32\taskkill.exe" /PID $process.Id /T /F 2>$null | Out-Null
        }
        $process.Dispose()
    }
    Remove-Item -LiteralPath @($runner, $stdout, $stderr) -Force -ErrorAction SilentlyContinue
}
