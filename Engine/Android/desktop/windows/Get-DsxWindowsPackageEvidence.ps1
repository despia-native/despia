# Reads the security-relevant identity and application resources from a jpackage
# Windows application image. Callers must still verify the native payload and
# installer signatures; this script proves what the signed launcher will load.

Set-StrictMode -Version Latest

$script:DsxWindowsRepositoryRoot = [System.IO.Path]::GetFullPath(
    (Join-Path $PSScriptRoot '../../../../..')
)

function Get-DsxSha256Hex {
    param([Parameter(Mandatory = $true)] [string] $LiteralPath)

    return (Get-FileHash -LiteralPath $LiteralPath -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Get-DsxStreamSha256Hex {
    param([Parameter(Mandatory = $true)] [System.IO.Stream] $Stream)

    $sha256 = [System.Security.Cryptography.SHA256]::Create()
    try {
        $digest = $sha256.ComputeHash($Stream)
        try {
            return [System.BitConverter]::ToString($digest).Replace('-', '').ToLowerInvariant()
        }
        finally {
            [Array]::Clear($digest, 0, $digest.Length)
        }
    }
    finally {
        $sha256.Dispose()
    }
}

function Get-DsxRelativePackagePath {
    param(
        [Parameter(Mandatory = $true)] [string] $Root,
        [Parameter(Mandatory = $true)] [string] $LiteralPath
    )

    return [System.IO.Path]::GetRelativePath($Root, $LiteralPath).Replace('\', '/')
}

function Assert-DsxPathBelowRoot {
    param(
        [Parameter(Mandatory = $true)] [string] $Root,
        [Parameter(Mandatory = $true)] [string] $LiteralPath,
        [Parameter(Mandatory = $true)] [string] $Label
    )

    $directorySeparator = [System.IO.Path]::DirectorySeparatorChar
    $canonicalRoot = [System.IO.Path]::GetFullPath($Root).TrimEnd([char[]] @($directorySeparator))
    $canonicalPath = [System.IO.Path]::GetFullPath($LiteralPath)
    $rootPrefix = $canonicalRoot + $directorySeparator
    if (-not $canonicalPath.StartsWith($rootPrefix, [StringComparison]::OrdinalIgnoreCase)) {
        throw "$Label escapes its trusted root: $canonicalPath"
    }

    $cursor = $canonicalPath
    while ($cursor.StartsWith($rootPrefix, [StringComparison]::OrdinalIgnoreCase)) {
        if (Test-Path -LiteralPath $cursor) {
            $item = Get-Item -LiteralPath $cursor -Force
            if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw "$Label contains a reparse point: $cursor"
            }
        }
        $parent = [System.IO.Path]::GetDirectoryName($cursor)
        if ([string]::IsNullOrWhiteSpace($parent) -or $parent -eq $cursor) { break }
        $cursor = $parent
    }

    return $canonicalPath
}

function Resolve-DsxRepositoryInput {
    param(
        [Parameter(Mandatory = $true)] [string] $RepositoryRoot,
        [Parameter(Mandatory = $true)] [string] $RelativePath,
        [Parameter(Mandatory = $true)] [ValidateSet('File', 'Directory')] [string] $Kind
    )

    if ($RelativePath.Length -gt 512 -or $RelativePath.Contains('\') -or
        [System.IO.Path]::IsPathRooted($RelativePath) -or
        $RelativePath -notmatch '^[A-Za-z0-9][A-Za-z0-9._/ -]*$') {
        throw "Invalid repository-relative $Kind path: $RelativePath"
    }
    $segments = @($RelativePath.Split('/'))
    if ($segments.Count -eq 0 -or @($segments | Where-Object {
        $_ -eq '' -or $_ -eq '.' -or $_ -eq '..'
    }).Count -gt 0) {
        throw "Repository-relative $Kind path traverses or contains an empty segment: $RelativePath"
    }

    $root = [System.IO.Path]::GetFullPath($RepositoryRoot)
    $candidate = Assert-DsxPathBelowRoot `
        -Root $root `
        -LiteralPath (Join-Path $root $RelativePath.Replace('/', [System.IO.Path]::DirectorySeparatorChar)) `
        -Label "Repository $Kind input"
    $item = Get-Item -LiteralPath $candidate -Force
    if ($Kind -eq 'File' -and $item.PSIsContainer) {
        throw "Expected a repository file: $RelativePath"
    }
    if ($Kind -eq 'Directory' -and -not $item.PSIsContainer) {
        throw "Expected a repository directory: $RelativePath"
    }
    return $item
}

function Read-DsxLauncherConfiguration {
    param([Parameter(Mandatory = $true)] [System.IO.FileInfo] $Configuration)

    $bytes = [System.IO.File]::ReadAllBytes($Configuration.FullName)
    try {
        $encoding = [System.Text.UTF8Encoding]::new($false, $true)
        $text = $encoding.GetString($bytes)
    }
    catch {
        throw "Launcher configuration is not strict UTF-8: $($Configuration.FullName)"
    }
    finally {
        if ($null -ne $bytes) { [Array]::Clear($bytes, 0, $bytes.Length) }
    }

    $records = [System.Collections.Generic.List[object]]::new()
    $section = ''
    $lineNumber = 0
    foreach ($line in ($text -split '\r?\n')) {
        $lineNumber += 1
        $trimmed = $line.Trim()
        if ([string]::IsNullOrWhiteSpace($trimmed) -or
            $trimmed.StartsWith('#') -or $trimmed.StartsWith(';')) {
            continue
        }
        if ($trimmed -match '^\[([A-Za-z][A-Za-z0-9]*)\]$') {
            $section = $Matches[1]
            continue
        }
        $separator = $line.IndexOf('=')
        if ([string]::IsNullOrWhiteSpace($section) -or $separator -le 0) {
            throw "Malformed launcher configuration line $lineNumber in $($Configuration.FullName)"
        }
        $key = $line.Substring(0, $separator).Trim()
        if ($key -notmatch '^[A-Za-z][A-Za-z0-9.-]*$') {
            throw "Invalid launcher configuration key on line ${lineNumber}: $key"
        }
        $records.Add([pscustomobject]@{
            section = $section
            key = $key
            value = $line.Substring($separator + 1)
        })
    }
    return $records.ToArray()
}

function Get-DsxExactJavaProperty {
    param(
        [Parameter(Mandatory = $true)] [object[]] $ConfigurationRecords,
        [Parameter(Mandatory = $true)] [string] $Name,
        [switch] $Optional
    )

    $propertyOption = "-D$Name"
    $prefix = "$propertyOption="
    $matches = @($ConfigurationRecords | Where-Object {
        $_.section -ceq 'JavaOptions' -and $_.key -ceq 'java-options' -and
        ($_.value -ceq $propertyOption -or
            $_.value.StartsWith($prefix, [StringComparison]::Ordinal))
    })
    if ($matches.Count -gt 1) {
        throw "Launcher configuration defines $Name more than once."
    }
    if ($matches.Count -eq 0) {
        if ($Optional) { return $null }
        throw "Launcher configuration does not define $Name."
    }
    if ($matches[0].value -ceq $propertyOption) {
        throw "Launcher configuration defines $Name without its required exact value."
    }
    return $matches[0].value.Substring($prefix.Length)
}

function Assert-DsxNoClasspathOverrides {
    param([Parameter(Mandatory = $true)] [object[]] $ConfigurationRecords)

    $javaOptions = @($ConfigurationRecords | Where-Object {
        $_.section -ceq 'JavaOptions' -and $_.key -ceq 'java-options'
    })
    foreach ($record in $javaOptions) {
        $value = $record.value.Trim()
        # The jpackage launcher accepts one JVM/launcher option per java-options
        # record. Quotes and whitespace may be removed by the native launcher, so
        # inspect token boundaries rather than only a literal prefix.
        if ($value -cmatch '(^|[\s"''])(-cp|-classpath|--class-path)(?=$|[\s="''])' -or
            $value -cmatch '(^|[\s"''])-Djava\.class\.path(?=$|[\s="''])') {
            throw "Launcher configuration contains a forbidden classpath override: $value"
        }
    }
}

function Assert-DsxExactJavaOptions {
    param(
        [Parameter(Mandatory = $true)] [object[]] $ConfigurationRecords,
        [Parameter(Mandatory = $true)] [string] $ExpectedVersion,
        [Parameter(Mandatory = $true)] [string] $ExpectedAppId,
        [Parameter(Mandatory = $true)] [string] $ExpectedAppTitle,
        [Parameter(Mandatory = $true)] [string] $ExpectedBuild,
        [AllowEmptyString()] [string] $ExpectedEntry
    )

    $unsupportedRecords = @($ConfigurationRecords | Where-Object {
        $_.section -cnotin @('Application', 'JavaOptions') -or
        ($_.section -ceq 'JavaOptions' -and $_.key -cne 'java-options')
    })
    if ($unsupportedRecords.Count -ne 0) {
        throw 'Launcher configuration contains a noncanonical section or option record.'
    }

    $expected = [System.Collections.Generic.List[string]]::new()
    $expected.Add("-Djpackage.app-version=$ExpectedVersion")
    # Compose emits the resources root with the packaging host's path separator
    # ($APPDIR\resources on Windows, $APPDIR/resources on Linux); the actual values
    # are normalized to '/' below, so pin the canonical, separator-agnostic form.
    $expected.Add('-Dcompose.application.resources.dir=$APPDIR/resources')
    $expected.Add('-Dcompose.application.configure.swing.globals=true')
    $expected.Add("-Ddsx.app.id=$ExpectedAppId")
    $expected.Add("-Ddsx.app.title=$ExpectedAppTitle")
    $expected.Add("-Ddsx.app.version=$ExpectedVersion")
    $expected.Add("-Ddsx.app.build=$ExpectedBuild")
    $expected.Add('-Ddsx.app.identity.locked=true')
    if (-not [string]::IsNullOrEmpty($ExpectedEntry)) {
        $expected.Add('-Ddsx.app.entry.resource=/dsx/AppEntry.dsx')
    }
    $expected.Add('-Dskiko.library.path=$APPDIR')

    $actual = @($ConfigurationRecords | Where-Object {
        $_.section -ceq 'JavaOptions' -and $_.key -ceq 'java-options'
    } | ForEach-Object {
        if ($_.value.StartsWith('-Dcompose.application.resources.dir=', [System.StringComparison]::Ordinal)) {
            $_.value.Replace('\', '/')
        } else {
            $_.value
        }
    })
    if ($actual.Count -ne $expected.Count) {
        throw "Launcher JavaOptions count $($actual.Count) does not match the canonical count $($expected.Count)."
    }
    $actualCounts = [System.Collections.Generic.Dictionary[string, int]]::new([StringComparer]::Ordinal)
    foreach ($value in $actual) {
        if ($actualCounts.ContainsKey($value)) { $actualCounts[$value] += 1 }
        else { $actualCounts.Add($value, 1) }
    }
    foreach ($value in $expected) {
        if (-not $actualCounts.ContainsKey($value) -or $actualCounts[$value] -ne 1) {
            throw "Launcher JavaOptions is missing or duplicates a canonical option: $value"
        }
        $actualCounts.Remove($value) | Out-Null
    }
    if ($actualCounts.Count -ne 0) {
        throw "Launcher JavaOptions contains an additional startup option: $(@($actualCounts.Keys) -join ', ')"
    }
}

function Resolve-DsxClasspathJars {
    param(
        [Parameter(Mandatory = $true)] [string] $ApplicationRoot,
        [Parameter(Mandatory = $true)] [System.IO.FileInfo] $Configuration,
        [Parameter(Mandatory = $true)] [object[]] $ConfigurationRecords
    )

    $applicationRecords = @($ConfigurationRecords | Where-Object {
        $_.section -ceq 'Application'
    })
    $mainClasses = @($applicationRecords | Where-Object { $_.key -ceq 'app.mainclass' })
    if ($mainClasses.Count -ne 1 -or
        $mainClasses[0].value -cne 'despia.engine.desktop.DesktopHostKt') {
        throw 'Launcher configuration must define exactly one canonical DSX app.mainclass.'
    }
    $mainJars = @($applicationRecords | Where-Object { $_.key -ceq 'app.mainjar' })
    if ($mainJars.Count -ne 0) {
        throw 'Launcher configuration must not define app.mainjar when DSX supplies an explicit main class.'
    }
    $mainModules = @($applicationRecords | Where-Object { $_.key -ceq 'app.mainmodule' })
    if ($mainModules.Count -ne 0) {
        throw 'Launcher configuration must not define app.mainmodule for the classpath DSX host.'
    }
    $classpathRecords = @($applicationRecords | Where-Object { $_.key -ceq 'app.classpath' })
    if ($classpathRecords.Count -eq 0) {
        throw 'Launcher configuration has no canonical app.classpath records.'
    }
    $canonicalKeys = [System.Collections.Generic.List[string]]::new()
    $canonicalKeys.Add('app.classpath')
    $canonicalKeys.Add('app.mainclass')
    for ($index = 1; $index -lt $classpathRecords.Count; $index += 1) {
        $canonicalKeys.Add('app.classpath')
    }
    $actualKeys = @($applicationRecords | ForEach-Object { $_.key })
    if (($actualKeys -join "`n") -cne ($canonicalKeys -join "`n")) {
        throw 'Launcher Application section is not the canonical main-JAR, main-class, dependency-classpath sequence.'
    }

    $jarFiles = [System.Collections.Generic.List[System.IO.FileInfo]]::new()
    $seen = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    $configurationRoot = $Configuration.Directory.FullName
    foreach ($record in $classpathRecords) {
        $reference = $record.value
        if (-not $reference.StartsWith('$APPDIR\', [StringComparison]::Ordinal) -or
            $reference.Contains('/') -or $reference.Contains(';') -or
            $reference.Contains('*') -or $reference.Contains('?')) {
            throw "Launcher app.classpath must be one canonical `$APPDIR\ JAR reference: $reference"
        }
        $relative = $reference.Substring(8)
        if ([string]::IsNullOrWhiteSpace($relative) -or
            $relative.Contains('\') -or
            $relative -cnotmatch '^[A-Za-z0-9][A-Za-z0-9._+-]*\.jar$' -or
            [System.IO.Path]::GetFileName($relative) -cne $relative) {
            throw "Launcher app.classpath must reference one adjacent JAR file: $reference"
        }
        $candidate = Assert-DsxPathBelowRoot `
            -Root $ApplicationRoot `
            -LiteralPath (Join-Path $configurationRoot $relative) `
            -Label 'Launcher classpath'
        $jar = Get-Item -LiteralPath $candidate -Force
        if ($jar.PSIsContainer -or $jar.Extension -ine '.jar' -or
            ($jar.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw "Launcher classpath entry is not a real JAR file: $($jar.FullName)"
        }
        if (-not $seen.Add($jar.FullName)) {
            throw "Launcher app.classpath contains a duplicate JAR reference: $reference"
        }
        $jarFiles.Add($jar)
    }
    if ($jarFiles.Count -eq 0) { throw 'Launcher classpath expands to no JAR files.' }
    return $jarFiles.ToArray()
}

function Assert-DsxJarManifestDoesNotExtendClasspath {
    param(
        [Parameter(Mandatory = $true)] [System.IO.Compression.ZipArchive] $Archive,
        [Parameter(Mandatory = $true)] [System.IO.FileInfo] $Jar
    )

    $manifests = @($Archive.Entries | Where-Object {
        $_.FullName.Equals('META-INF/MANIFEST.MF', [StringComparison]::OrdinalIgnoreCase)
    })
    if ($manifests.Count -gt 1) {
        throw "Classpath JAR contains multiple manifest resources: $($Jar.FullName)"
    }
    if ($manifests.Count -eq 0) { return }
    $manifest = $manifests[0]
    if ($manifest.Length -lt 0 -or $manifest.Length -gt 1048576) {
        throw "Classpath JAR manifest exceeds the 1 MiB boundary: $($Jar.FullName)"
    }
    $stream = $manifest.Open()
    $memory = [System.IO.MemoryStream]::new()
    $bytes = $null
    $text = $null
    try {
        $stream.CopyTo($memory)
        $bytes = $memory.ToArray()
        try {
            $encoding = [System.Text.UTF8Encoding]::new($false, $true)
            $text = $encoding.GetString($bytes)
        }
        catch {
            throw "Classpath JAR manifest is not strict UTF-8: $($Jar.FullName)"
        }
        finally {
            if ($null -ne $bytes) { [Array]::Clear($bytes, 0, $bytes.Length) }
        }
    }
    finally {
        $memory.Dispose()
        $stream.Dispose()
    }
    if ($text.Contains([char]0)) {
        throw "Classpath JAR manifest contains NUL: $($Jar.FullName)"
    }

    $currentAttribute = $null
    foreach ($line in (($text.Replace("`r`n", "`n")).Replace("`r", "`n") -split "`n")) {
        if ($line.Length -eq 0) { break }
        if ($line.StartsWith(' ', [StringComparison]::Ordinal)) {
            if ($null -eq $currentAttribute) {
                throw "Classpath JAR manifest begins with an invalid continuation: $($Jar.FullName)"
            }
            # A continued Class-Path value remains forbidden; the attribute was
            # rejected on its first physical line below.
            continue
        }
        if ($line -notmatch '^([^:]+): (.*)$') {
            throw "Classpath JAR manifest contains a malformed main attribute: $($Jar.FullName)"
        }
        $currentAttribute = $Matches[1]
        if ($currentAttribute.Equals('Class-Path', [StringComparison]::OrdinalIgnoreCase)) {
            throw "Classpath JAR manifest must not define Class-Path: $($Jar.FullName)"
        }
    }
}

function Assert-DsxDesktopMainClassOwnership {
    param([Parameter(Mandatory = $true)] [System.IO.FileInfo[]] $ClasspathJars)

    $mainClassPath = 'despia/engine/desktop/DesktopHostKt.class'
    $owners = [System.Collections.Generic.List[string]]::new()
    foreach ($jar in $ClasspathJars) {
        $archive = [System.IO.Compression.ZipFile]::OpenRead($jar.FullName)
        try {
            Assert-DsxJarManifestDoesNotExtendClasspath -Archive $archive -Jar $jar
            $versionedMatches = @($archive.Entries | Where-Object {
                $_.FullName -cmatch '^META-INF/versions/[1-9][0-9]*/despia/engine/desktop/DesktopHostKt\.class$'
            })
            if ($versionedMatches.Count -gt 0) {
                throw "Classpath JAR contains a versioned canonical DSX main-class shadow: $($jar.FullName)"
            }
            $matches = @($archive.Entries | Where-Object { $_.FullName -ceq $mainClassPath })
            if ($matches.Count -gt 1) {
                throw "Classpath JAR contains duplicate canonical DSX main classes: $($jar.FullName)"
            }
            if ($matches.Count -eq 1) { $owners.Add($jar.FullName) }
        }
        finally {
            $archive.Dispose()
        }
    }
    if ($owners.Count -ne 1) {
        throw "Launcher classpath must contain exactly one $mainClassPath; found $($owners.Count)."
    }
    if ($owners[0] -cne $ClasspathJars[0].FullName) {
        throw 'The first app.classpath JAR must own the canonical DSX main class.'
    }
}

function Get-DsxPackagedResourceInventory {
    param(
        [Parameter(Mandatory = $true)] [string] $ApplicationRoot,
        [Parameter(Mandatory = $true)] [System.IO.FileInfo[]] $ClasspathJars
    )

    $records = [System.Collections.Generic.List[object]]::new()
    $seen = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    [long] $totalBytes = 0
    foreach ($jar in $ClasspathJars) {
        $archive = [System.IO.Compression.ZipFile]::OpenRead($jar.FullName)
        try {
            foreach ($entry in $archive.Entries) {
                $resourcePath = $entry.FullName
                $isAppIdentity = $resourcePath -ceq 'dsx/AppIdentity.properties'
                $isAppEntry = $resourcePath -ceq 'dsx/AppEntry.dsx'
                $isAppAsset = $resourcePath.StartsWith('dsx/app-assets/', [StringComparison]::Ordinal)
                if (-not $isAppIdentity -and -not $isAppEntry -and -not $isAppAsset) { continue }
                if ([string]::IsNullOrEmpty($entry.Name)) { continue }
                if ($resourcePath.Contains('\') -or $resourcePath.StartsWith('/') -or
                    $resourcePath.Split('/') -contains '..' -or
                    $resourcePath.Split('/') -contains '.') {
                    throw "Unsafe packaged DSX resource path: $resourcePath"
                }
                if (-not $seen.Add($resourcePath)) {
                    throw "Packaged DSX resource is shadowed by multiple classpath JARs: $resourcePath"
                }
                if ($entry.Length -lt 0 -or $entry.Length -gt 67108864) {
                    throw "Packaged DSX resource exceeds the 64 MiB per-file boundary: $resourcePath"
                }
                $totalBytes += $entry.Length
                if ($totalBytes -gt 268435456 -or $records.Count -ge 4096) {
                    throw 'Packaged DSX resources exceed the bounded file-count or total-size contract.'
                }
                $stream = $entry.Open()
                try {
                    $hash = Get-DsxStreamSha256Hex -Stream $stream
                }
                finally {
                    $stream.Dispose()
                }
                $records.Add([pscustomobject][ordered]@{
                    path = $resourcePath
                    bytes = [long] $entry.Length
                    sha256 = $hash
                    classpathJar = Get-DsxRelativePackagePath `
                        -Root $ApplicationRoot -LiteralPath $jar.FullName
                })
            }
        }
        finally {
            $archive.Dispose()
        }
    }
    return @($records | Sort-Object path)
}

function Read-DsxClasspathUtf8Resource {
    param(
        [Parameter(Mandatory = $true)] [System.IO.FileInfo[]] $ClasspathJars,
        [Parameter(Mandatory = $true)] [string] $ResourcePath
    )

    $matches = [System.Collections.Generic.List[object]]::new()
    foreach ($jar in $ClasspathJars) {
        $archive = [System.IO.Compression.ZipFile]::OpenRead($jar.FullName)
        try {
            foreach ($entry in $archive.Entries) {
                if ($entry.FullName -ceq $ResourcePath) {
                    if ($entry.Length -lt 1 -or $entry.Length -gt 16384) {
                        throw "Packaged identity resource has an invalid size: $($entry.Length)"
                    }
                    $stream = $entry.Open()
                    $memory = [System.IO.MemoryStream]::new()
                    try {
                        $stream.CopyTo($memory)
                        $matches.Add($memory.ToArray())
                    }
                    finally {
                        $memory.Dispose()
                        $stream.Dispose()
                    }
                }
            }
        }
        finally {
            $archive.Dispose()
        }
    }
    if ($matches.Count -ne 1) {
        throw "Launcher classpath must contain exactly one $ResourcePath; found $($matches.Count)."
    }

    $bytes = [byte[]] $matches[0]
    try {
        $encoding = [System.Text.UTF8Encoding]::new($false, $true)
        return $encoding.GetString($bytes)
    }
    catch {
        throw "$ResourcePath is not strict UTF-8."
    }
    finally {
        [Array]::Clear($bytes, 0, $bytes.Length)
    }
}

function Get-DsxExpectedResourceInventory {
    param(
        [Parameter(Mandatory = $true)] [string] $RepositoryRoot,
        [AllowEmptyString()] [string] $ExpectedEntry,
        [AllowEmptyString()] [string] $ExpectedAssets
    )

    $records = [System.Collections.Generic.List[object]]::new()
    if (-not [string]::IsNullOrEmpty($ExpectedEntry)) {
        if (-not $ExpectedEntry.EndsWith('.dsx', [StringComparison]::OrdinalIgnoreCase)) {
            throw 'ExpectedEntry must identify a .dsx file.'
        }
        $entry = Resolve-DsxRepositoryInput `
            -RepositoryRoot $RepositoryRoot -RelativePath $ExpectedEntry -Kind File
        $records.Add([pscustomobject][ordered]@{
            path = 'dsx/AppEntry.dsx'
            bytes = [long] $entry.Length
            sha256 = Get-DsxSha256Hex -LiteralPath $entry.FullName
        })
    }

    if (-not [string]::IsNullOrEmpty($ExpectedAssets)) {
        $assets = Resolve-DsxRepositoryInput `
            -RepositoryRoot $RepositoryRoot -RelativePath $ExpectedAssets -Kind Directory
        $descendants = @(Get-ChildItem -LiteralPath $assets.FullName -Recurse -Force)
        $reparsePoint = @($descendants | Where-Object {
            ($_.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0
        } | Select-Object -First 1)
        if ($reparsePoint.Count -gt 0) {
            throw "ExpectedAssets contains a reparse point: $($reparsePoint[0].FullName)"
        }
        foreach ($file in @($descendants | Where-Object { -not $_.PSIsContainer })) {
            $relative = Get-DsxRelativePackagePath -Root $assets.FullName -LiteralPath $file.FullName
            if ($relative.Split('/') -contains '..' -or $relative.Contains('\')) {
                throw "Unsafe ExpectedAssets path: $relative"
            }
            $records.Add([pscustomobject][ordered]@{
                path = "dsx/app-assets/$relative"
                bytes = [long] $file.Length
                sha256 = Get-DsxSha256Hex -LiteralPath $file.FullName
            })
        }
    }
    return @($records | Sort-Object path)
}

function Assert-DsxResourceInventory {
    param(
        [Parameter(Mandatory = $true)] [AllowEmptyCollection()] [object[]] $Actual,
        [Parameter(Mandatory = $true)] [AllowEmptyCollection()] [object[]] $Expected
    )

    if ($Actual.Count -ne $Expected.Count) {
        throw "Packaged DSX resource count $($Actual.Count) does not match source inventory $($Expected.Count)."
    }
    for ($index = 0; $index -lt $Expected.Count; $index += 1) {
        if ($Actual[$index].path -cne $Expected[$index].path -or
            [long] $Actual[$index].bytes -ne [long] $Expected[$index].bytes -or
            $Actual[$index].sha256 -cne $Expected[$index].sha256) {
            throw "Packaged DSX resource identity mismatch at index ${index}: $($Actual[$index].path)"
        }
    }
}

function Get-DsxWindowsPackageEvidence {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)] [string] $ApplicationRoot,
        [Parameter(Mandatory = $true)] [string] $Launcher,
        [Parameter(Mandatory = $true)] [string] $ExpectedVersion,
        [Parameter(Mandatory = $true)] [string] $ExpectedAppId,
        [Parameter(Mandatory = $true)] [string] $ExpectedAppTitle,
        [Parameter(Mandatory = $true)] [string] $ExpectedBuild,
        [AllowEmptyString()] [string] $ExpectedEntry = '',
        [AllowEmptyString()] [string] $ExpectedAssets = '',
        [string] $RepositoryRoot = $script:DsxWindowsRepositoryRoot
    )

    $root = (Get-Item -LiteralPath $ApplicationRoot -Force)
    if (-not $root.PSIsContainer -or
        ($root.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "ApplicationRoot must be a real directory: $ApplicationRoot"
    }
    $launcherFile = Get-Item -LiteralPath `
        (Assert-DsxPathBelowRoot -Root $root.FullName -LiteralPath $Launcher -Label Launcher) -Force
    if ($launcherFile.PSIsContainer -or $launcherFile.Name -cne "$ExpectedAppTitle.exe") {
        throw "Unexpected packaged launcher: $($launcherFile.FullName)"
    }

    $configurationPath = Join-Path $root.FullName (Join-Path 'app' "$ExpectedAppTitle.cfg")
    $configuration = Get-Item -LiteralPath `
        (Assert-DsxPathBelowRoot -Root $root.FullName -LiteralPath $configurationPath -Label 'Launcher configuration') `
        -Force
    if ($configuration.PSIsContainer) { throw "Launcher configuration is not a file: $configurationPath" }
    # Only the launcher configuration under app\ is policed here. The embedded JVM
    # runtime legitimately ships its own JDK-owned configuration (runtime\lib\jvm.cfg);
    # the runtime image is verified separately, so exclude its subtree rather than
    # counting jvm.cfg as a second, rogue launcher configuration.
    $runtimePrefix = (Join-Path $root.FullName 'runtime') + [System.IO.Path]::DirectorySeparatorChar
    $allConfigurations = @(Get-ChildItem -LiteralPath $root.FullName -Recurse -Force -File -Filter '*.cfg' |
        Where-Object { -not $_.FullName.StartsWith($runtimePrefix, [System.StringComparison]::OrdinalIgnoreCase) })
    if ($allConfigurations.Count -ne 1 -or
        $allConfigurations[0].FullName -ine $configuration.FullName) {
        throw "Application image must contain exactly one launcher configuration; found $($allConfigurations.Count)."
    }

    $configurationRecords = @(Read-DsxLauncherConfiguration -Configuration $configuration)
    Assert-DsxNoClasspathOverrides -ConfigurationRecords $configurationRecords
    $canonicalAppId = $ExpectedAppId.ToLowerInvariant()
    Assert-DsxExactJavaOptions `
        -ConfigurationRecords $configurationRecords `
        -ExpectedVersion $ExpectedVersion `
        -ExpectedAppId $canonicalAppId `
        -ExpectedAppTitle $ExpectedAppTitle `
        -ExpectedBuild $ExpectedBuild `
        -ExpectedEntry $ExpectedEntry
    $actualAppId = Get-DsxExactJavaProperty -ConfigurationRecords $configurationRecords -Name 'dsx.app.id'
    $actualTitle = Get-DsxExactJavaProperty -ConfigurationRecords $configurationRecords -Name 'dsx.app.title'
    $actualVersion = Get-DsxExactJavaProperty -ConfigurationRecords $configurationRecords -Name 'dsx.app.version'
    $jpackageVersion = Get-DsxExactJavaProperty -ConfigurationRecords $configurationRecords -Name 'jpackage.app-version'
    $actualBuild = Get-DsxExactJavaProperty -ConfigurationRecords $configurationRecords -Name 'dsx.app.build'
    $identityLocked = Get-DsxExactJavaProperty `
        -ConfigurationRecords $configurationRecords -Name 'dsx.app.identity.locked'
    $entryResource = Get-DsxExactJavaProperty `
        -ConfigurationRecords $configurationRecords -Name 'dsx.app.entry.resource' -Optional

    if ($actualAppId -cne $canonicalAppId -or $actualTitle -cne $ExpectedAppTitle -or
        $actualVersion -cne $ExpectedVersion -or $jpackageVersion -cne $ExpectedVersion -or
        $actualBuild -cne $ExpectedBuild -or $identityLocked -cne 'true') {
        throw 'Launcher configuration identity/version/build/lock evidence does not match the requested package.'
    }
    $expectedEntryResource = if ([string]::IsNullOrEmpty($ExpectedEntry)) {
        $null
    }
    else {
        '/dsx/AppEntry.dsx'
    }
    if ($entryResource -cne $expectedEntryResource) {
        throw "Launcher entry-resource evidence mismatch: '$entryResource'"
    }

    $classpathJars = @(Resolve-DsxClasspathJars `
        -ApplicationRoot $root.FullName `
        -Configuration $configuration `
        -ConfigurationRecords $configurationRecords)
    Assert-DsxDesktopMainClassOwnership -ClasspathJars $classpathJars
    $actualResources = @(Get-DsxPackagedResourceInventory `
        -ApplicationRoot $root.FullName -ClasspathJars $classpathJars)
    $identityResourcePath = 'dsx/AppIdentity.properties'
    $identityRecords = @($actualResources | Where-Object { $_.path -ceq $identityResourcePath })
    if ($identityRecords.Count -ne 1) {
        throw "Package evidence requires exactly one $identityResourcePath resource."
    }
    $identityText = Read-DsxClasspathUtf8Resource `
        -ClasspathJars $classpathJars -ResourcePath $identityResourcePath
    $identityEntryResource = if ([string]::IsNullOrEmpty($ExpectedEntry)) {
        ''
    }
    else {
        '/dsx/AppEntry.dsx'
    }
    $identityAssetsPrefix = if ([string]::IsNullOrEmpty($ExpectedAssets)) {
        ''
    }
    else {
        '/dsx/app-assets'
    }
    $expectedIdentityText = (@(
        'dsx.identity.schema=dev.dsx.desktop-app-identity/v1'
        "dsx.app.id=$canonicalAppId"
        "dsx.app.title=$ExpectedAppTitle"
        "dsx.app.version=$ExpectedVersion"
        "dsx.app.build=$ExpectedBuild"
        'dsx.app.identity.locked=true'
        "dsx.app.entry.resource=$identityEntryResource"
        "dsx.app.assets.prefix=$identityAssetsPrefix"
    ) -join "`n") + "`n"
    if ($identityText -cne $expectedIdentityText) {
        throw 'Packaged AppIdentity.properties is not the exact LF-only build-owned identity contract.'
    }
    $identityAssetsPrefixKey = 'dsx.app.assets.prefix='
    $actualIdentityAssetsPrefix = $identityText.Split("`n")[7].Substring(
        $identityAssetsPrefixKey.Length
    )
    $expectedResources = @(Get-DsxExpectedResourceInventory `
        -RepositoryRoot $RepositoryRoot -ExpectedEntry $ExpectedEntry -ExpectedAssets $ExpectedAssets)
    $actualApplicationResources = @($actualResources | Where-Object {
        $_.path -cne $identityResourcePath
    })
    Assert-DsxResourceInventory -Actual $actualApplicationResources -Expected $expectedResources

    $classpathRecords = @($classpathJars | ForEach-Object {
        [pscustomobject][ordered]@{
            path = Get-DsxRelativePackagePath -Root $root.FullName -LiteralPath $_.FullName
            bytes = [long] $_.Length
            sha256 = Get-DsxSha256Hex -LiteralPath $_.FullName
        }
    } | Sort-Object path)

    return [pscustomobject][ordered]@{
        schema = 'dev.dsx.windows-package-evidence/v1'
        applicationId = $actualAppId
        product = $actualTitle
        version = $actualVersion
        build = $actualBuild
        identityLocked = $true
        entryResource = $entryResource
        assetsPrefix = $actualIdentityAssetsPrefix
        identityResource = $identityResourcePath
        identitySha256 = $identityRecords[0].sha256
        launcher = Get-DsxRelativePackagePath -Root $root.FullName -LiteralPath $launcherFile.FullName
        configuration = Get-DsxRelativePackagePath `
            -Root $root.FullName -LiteralPath $configuration.FullName
        configurationSha256 = Get-DsxSha256Hex -LiteralPath $configuration.FullName
        classpathJars = $classpathRecords
        resources = $actualResources
    }
}

function Assert-DsxWindowsPackageEvidenceMatch {
    param(
        [Parameter(Mandatory = $true)] [object] $Recorded,
        [Parameter(Mandatory = $true)] [object] $Installed
    )

    $recordedJson = $Recorded | ConvertTo-Json -Depth 10 -Compress
    $installedJson = $Installed | ConvertTo-Json -Depth 10 -Compress
    if ($recordedJson -cne $installedJson) {
        throw 'Installed launcher configuration or packaged DSX resource evidence differs from the signed payload manifest.'
    }
}
