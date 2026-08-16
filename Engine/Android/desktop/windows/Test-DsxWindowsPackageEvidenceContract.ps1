# Portable behavioral probe for the jpackage launcher/configuration evidence
# contract. It intentionally needs only PowerShell 7 and .NET, so both the
# Windows release runner and non-Windows audit hosts can execute it.

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

. "$PSScriptRoot/Get-DsxWindowsPackageEvidence.ps1"

$testRoot = Join-Path ([System.IO.Path]::GetTempPath()) "dsx-windows-evidence-$([Guid]::NewGuid().ToString('N'))"
$applicationRoot = Join-Path $testRoot 'image'
$applicationDirectory = Join-Path $applicationRoot 'app'
$launcher = Join-Path $applicationRoot 'Audit App.exe'
$configuration = Join-Path $applicationDirectory 'Audit App.cfg'
$script:rejectionCount = 0

$identityText = (@(
    'dsx.identity.schema=dev.dsx.desktop-app-identity/v1'
    'dsx.app.id=com.example.audit-app'
    'dsx.app.title=Audit App'
    'dsx.app.version=1.2.3'
    'dsx.app.build=probe-7'
    'dsx.app.identity.locked=true'
    'dsx.app.entry.resource='
    'dsx.app.assets.prefix='
) -join "`n") + "`n"

$script:canonicalJavaOptions = @(
    'java-options=-Djpackage.app-version=1.2.3'
    # Windows-style backslash separator, which the evidence contract normalizes.
    'java-options=-Dcompose.application.resources.dir=$APPDIR\resources'
    'java-options=-Dcompose.application.configure.swing.globals=true'
    'java-options=-Ddsx.app.id=com.example.audit-app'
    'java-options=-Ddsx.app.title=Audit App'
    'java-options=-Ddsx.app.version=1.2.3'
    'java-options=-Ddsx.app.build=probe-7'
    'java-options=-Ddsx.app.identity.locked=true'
    'java-options=-Dskiko.library.path=$APPDIR'
)

function Add-TestJarEntry {
    param(
        [Parameter(Mandatory = $true)] [System.IO.Compression.ZipArchive] $Archive,
        [Parameter(Mandatory = $true)] [string] $Name,
        [Parameter(Mandatory = $true)] [byte[]] $Bytes
    )

    $entry = $Archive.CreateEntry($Name)
    $stream = $entry.Open()
    try { $stream.Write($Bytes, 0, $Bytes.Length) }
    finally { $stream.Dispose() }
}

function Write-TestJar {
    param(
        [Parameter(Mandatory = $true)] [string] $LiteralPath,
        [switch] $OwnsMainClass,
        [switch] $OwnsIdentity,
        [string] $ManifestText = "Manifest-Version: 1.0`n"
    )

    if (Test-Path -LiteralPath $LiteralPath) { Remove-Item -LiteralPath $LiteralPath -Force }
    $archive = [System.IO.Compression.ZipFile]::Open(
        $LiteralPath,
        [System.IO.Compression.ZipArchiveMode]::Create
    )
    try {
        Add-TestJarEntry -Archive $archive -Name 'META-INF/MANIFEST.MF' `
            -Bytes ([System.Text.Encoding]::UTF8.GetBytes($ManifestText))
        if ($OwnsMainClass) {
            Add-TestJarEntry -Archive $archive `
                -Name 'despia/engine/desktop/DesktopHostKt.class' `
                -Bytes ([byte[]](0xca, 0xfe, 0xba, 0xbe))
        }
        if ($OwnsIdentity) {
            Add-TestJarEntry -Archive $archive -Name 'dsx/AppIdentity.properties' `
                -Bytes ([System.Text.Encoding]::UTF8.GetBytes($identityText))
        }
    }
    finally { $archive.Dispose() }
}

function Write-TestConfiguration {
    param(
        [Parameter(Mandatory = $true)] [string[]] $ApplicationLines,
        [string[]] $JavaOptions = $script:canonicalJavaOptions,
        [string[]] $ExtraJavaOptions = @()
    )

    $lines = @('[Application]') + $ApplicationLines + @('[JavaOptions]') +
        $JavaOptions + $ExtraJavaOptions
    [System.IO.File]::WriteAllText(
        $configuration,
        ($lines -join "`n") + "`n",
        [System.Text.UTF8Encoding]::new($false)
    )
}

function Get-TestEvidence {
    return Get-DsxWindowsPackageEvidence `
        -ApplicationRoot $applicationRoot `
        -Launcher $launcher `
        -ExpectedVersion '1.2.3' `
        -ExpectedAppId 'com.example.audit-app' `
        -ExpectedAppTitle 'Audit App' `
        -ExpectedBuild 'probe-7' `
        -RepositoryRoot $testRoot
}

function Assert-ConfigurationRejected {
    param(
        [Parameter(Mandatory = $true)] [string] $Name,
        [Parameter(Mandatory = $true)] [string[]] $ApplicationLines,
        [string[]] $JavaOptions = $script:canonicalJavaOptions,
        [string[]] $ExtraJavaOptions = @()
    )

    Write-TestConfiguration `
        -ApplicationLines $ApplicationLines `
        -JavaOptions $JavaOptions `
        -ExtraJavaOptions $ExtraJavaOptions
    Assert-CurrentEvidenceRejected -Name $Name
}

function Assert-CurrentEvidenceRejected {
    param([Parameter(Mandatory = $true)] [string] $Name)

    $rejected = $false
    try { $null = Get-TestEvidence }
    catch { $rejected = $true }
    if (-not $rejected) { throw "Evidence probe accepted forbidden case: $Name" }
    $script:rejectionCount += 1
}

$canonicalApplication = @(
    'app.classpath=$APPDIR\desktop.jar'
    'app.mainclass=despia.engine.desktop.DesktopHostKt'
    'app.classpath=$APPDIR\dependency.jar'
)

try {
    [System.IO.Directory]::CreateDirectory($applicationDirectory) | Out-Null
    [System.IO.File]::WriteAllBytes($launcher, [byte[]](0x4d, 0x5a))
    Write-TestJar -LiteralPath (Join-Path $applicationDirectory 'desktop.jar') -OwnsMainClass -OwnsIdentity
    Write-TestJar -LiteralPath (Join-Path $applicationDirectory 'dependency.jar')
    Write-TestJar -LiteralPath (Join-Path $applicationDirectory 'shadow.jar') -OwnsMainClass

    Write-TestConfiguration -ApplicationLines $canonicalApplication
    $positive = Get-TestEvidence
    if ($positive.schema -cne 'dev.dsx.windows-package-evidence/v1' -or
        $positive.classpathJars.Count -ne 2) {
        throw 'Canonical launcher configuration did not produce the expected package evidence.'
    }

    Assert-ConfigurationRejected -Name 'missing main class' -ApplicationLines @(
        'app.classpath=$APPDIR\desktop.jar'
    )
    Assert-ConfigurationRejected -Name 'wrong main class' -ApplicationLines @(
        'app.classpath=$APPDIR\desktop.jar'
        'app.mainclass=example.Impostor'
    )
    Assert-ConfigurationRejected -Name 'duplicate main class' -ApplicationLines @(
        'app.classpath=$APPDIR\desktop.jar'
        'app.mainclass=despia.engine.desktop.DesktopHostKt'
        'app.mainclass=despia.engine.desktop.DesktopHostKt'
    )
    Assert-ConfigurationRejected -Name 'main JAR override' -ApplicationLines @(
        $canonicalApplication + 'app.mainjar=$APPDIR\desktop.jar'
    )
    Assert-ConfigurationRejected -Name 'main module override' -ApplicationLines @(
        $canonicalApplication + 'app.mainmodule=evil.module/evil.Main'
    )
    Assert-ConfigurationRejected -Name 'noncanonical application order' -ApplicationLines @(
        'app.mainclass=despia.engine.desktop.DesktopHostKt'
        'app.classpath=$APPDIR\desktop.jar'
    )
    Assert-ConfigurationRejected -Name 'semicolon classpath' -ApplicationLines @(
        'app.classpath=$APPDIR\desktop.jar;$APPDIR\dependency.jar'
        'app.mainclass=despia.engine.desktop.DesktopHostKt'
    )
    Assert-ConfigurationRejected -Name 'wildcard classpath' -ApplicationLines @(
        'app.classpath=$APPDIR\*.jar'
        'app.mainclass=despia.engine.desktop.DesktopHostKt'
    )
    Assert-ConfigurationRejected -Name 'forward-slash classpath' -ApplicationLines @(
        'app.classpath=$APPDIR/desktop.jar'
        'app.mainclass=despia.engine.desktop.DesktopHostKt'
    )
    Assert-ConfigurationRejected -Name 'duplicate classpath JAR' -ApplicationLines @(
        $canonicalApplication + 'app.classpath=$APPDIR\desktop.jar'
    )
    Assert-ConfigurationRejected -Name 'main-class shadowing' -ApplicationLines @(
        $canonicalApplication + 'app.classpath=$APPDIR\shadow.jar'
    )
    Assert-ConfigurationRejected -Name 'dependency owns main class' -ApplicationLines @(
        'app.classpath=$APPDIR\dependency.jar'
        'app.mainclass=despia.engine.desktop.DesktopHostKt'
        'app.classpath=$APPDIR\desktop.jar'
    )

    Assert-ConfigurationRejected `
        -Name 'missing Compose globals option' `
        -ApplicationLines $canonicalApplication `
        -JavaOptions @($script:canonicalJavaOptions | Where-Object {
            $_ -cne 'java-options=-Dcompose.application.configure.swing.globals=true'
        })
    Assert-ConfigurationRejected `
        -Name 'missing Skiko path option' `
        -ApplicationLines $canonicalApplication `
        -JavaOptions @($script:canonicalJavaOptions | Where-Object {
            $_ -cne 'java-options=-Dskiko.library.path=$APPDIR'
        })
    Assert-ConfigurationRejected `
        -Name 'duplicate canonical Java option' `
        -ApplicationLines $canonicalApplication `
        -ExtraJavaOptions @('java-options=-Ddsx.app.identity.locked=true')

    @(
        'java-options=-javaagent:evil.jar'
        'java-options=-agentpath:evil.dll'
        'java-options=-Xbootclasspath/a:evil.jar'
        'java-options=--patch-module=java.base=evil.jar'
        'java-options=-Dunapproved.startup.option=true'
    ).ForEach({
        Assert-ConfigurationRejected -Name $_ -ApplicationLines $canonicalApplication -ExtraJavaOptions @($_)
    })

    @(
        'java-options=-cp'
        'java-options=-cp=evil.jar'
        'java-options="-cp evil.jar"'
        'java-options=-classpath'
        'java-options=-classpath=evil.jar'
        "java-options='-classpath evil.jar'"
        'java-options=--class-path'
        'java-options=--class-path=evil.jar'
        'java-options="--class-path evil.jar"'
        'java-options=-Djava.class.path'
        'java-options=-Djava.class.path=evil.jar'
        'java-options="-Djava.class.path=evil.jar"'
    ).ForEach({
        Assert-ConfigurationRejected -Name $_ -ApplicationLines $canonicalApplication -ExtraJavaOptions @($_)
    })

    Write-TestJar `
        -LiteralPath (Join-Path $applicationDirectory 'dependency.jar') `
        -ManifestText "Manifest-Version: 1.0`r`ncLaSs-PaTh: shadow.jar`r`n continuation.jar`r`n`r`n"
    Write-TestConfiguration -ApplicationLines $canonicalApplication
    Assert-CurrentEvidenceRejected -Name 'continued mixed-case manifest Class-Path'

    Write-Output "DSX Windows package evidence probe passed: 1 positive, $script:rejectionCount rejected tamper cases."
}
finally {
    if (Test-Path -LiteralPath $testRoot) {
        Remove-Item -LiteralPath $testRoot -Recurse -Force
    }
}
