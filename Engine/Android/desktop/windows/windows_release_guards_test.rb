#!/usr/bin/env ruby
# frozen_string_literal: true

require "minitest/autorun"
require "digest"
require "json"
require "open3"
require "pathname"
require "yaml"

class WindowsDesktopReleaseGuardsTest < Minitest::Test
  ROOT = Pathname(__dir__).join("../../../../..").expand_path.freeze
  WORKFLOW = ROOT.join(".github/workflows/windows-desktop.yml").freeze
  WINDOWS = ROOT.join("OpenSource/Engine/Android/desktop/windows").freeze
  PACKAGE_EVIDENCE_PROBE = WINDOWS.join("Test-DsxWindowsPackageEvidenceContract.ps1").freeze
  EXE_LIFECYCLE = WINDOWS.join("Test-DsxWindowsExeLifecycle.ps1").freeze

  def source(name)
    WINDOWS.join(name).read(encoding: "UTF-8")
  end

  def test_workflow_is_a_bounded_real_windows_lane
    yaml = WORKFLOW.read(encoding: "UTF-8")
    parsed = YAML.safe_load(yaml, aliases: false)
    jobs = parsed.fetch("jobs")

    assert_includes yaml, "windows-2025"
    assert_includes yaml, "timeout-minutes:"
    assert_includes yaml, ":desktop:packageMsi"
    assert_includes yaml, ":desktop:packageExe"
    assert_includes yaml, "Test-DsxWindowsInstall.ps1"
    assert_includes yaml, "windows-production"
    assert_equal "read", parsed.fetch("permissions").fetch("contents")
    assert jobs.key?("build-test-package")
    assert jobs.key?("sign-release")
  end

  def test_every_action_is_immutable_and_credentials_do_not_persist
    yaml = WORKFLOW.read(encoding: "UTF-8")
    uses = yaml.scan(/^\s*-?\s*uses:\s*([^\s#]+)/).flatten
    refute_empty uses
    uses.each do |action|
      assert_match(%r{\A[\w.-]+/[\w./-]+@[0-9a-f]{40}\z}, action, "floating action: #{action}")
    end
    assert_includes yaml, "persist-credentials: false"
  end

  def test_checkout_is_sparse_and_never_materializes_apple_pods
    parsed = YAML.safe_load(WORKFLOW.read(encoding: "UTF-8"), aliases: false)
    checkout_steps = parsed.fetch("jobs").values.flat_map { |job| job.fetch("steps") }
      .select { |step| step.fetch("uses", "").start_with?("actions/checkout@") }

    assert_equal 2, checkout_steps.length
    checkout_steps.each do |step|
      inputs = step.fetch("with")
      assert_equal false, inputs.fetch("persist-credentials")
      assert_equal false, inputs.fetch("sparse-checkout-cone-mode")
      patterns = inputs.fetch("sparse-checkout").lines.map(&:strip)
      assert_includes patterns, "/*"
      assert_includes patterns, "!/ClosedSource/Pods/"
    end
  end

  def test_build_and_sign_jobs_are_fail_closed_to_windows_x64
    yaml = WORKFLOW.read(encoding: "UTF-8")

    # 5 gradle invocations (added the QA-demo pre-compile step that keeps the demo
    # window-wait off the cold compile); each stays fail-closed to windows-x64, so
    # both counts move together.
    assert_equal 5, yaml.scan("--settings-file settings-desktop.gradle.kts").length
    assert_equal 5, yaml.scan("-PdsxDesktopTarget=windows-x64").length
    assert_equal 2, yaml.scan("RuntimeInformation]::OSArchitecture").length
    assert_equal 2, yaml.scan("Architecture]::X64").length
    assert_operator yaml.scan("ARM64 remains unqualified").length, :>=, 2
  end

  def test_app_configuration_is_explicit_and_identical_in_build_and_sign_jobs
    yaml = WORKFLOW.read(encoding: "UTF-8")
    parsed = YAML.safe_load(yaml, aliases: false)
    environment = parsed.fetch("env")
    assert_includes environment.fetch("DSX_DESKTOP_APP_ID"), "dev.dsx.runtime"
    assert_includes environment.fetch("DSX_DESKTOP_TITLE"), "DSX"
    assert_includes environment.fetch("DSX_DESKTOP_BUILD"), "github.run_number"
    assert_equal "${{ vars.DSX_DESKTOP_ENTRY || '' }}", environment.fetch("DSX_DESKTOP_ENTRY")
    assert_equal "${{ vars.DSX_DESKTOP_ASSETS || '' }}", environment.fetch("DSX_DESKTOP_ASSETS")

    jobs = parsed.fetch("jobs")
    build_job = jobs.fetch("build-test-package")
    sign_job = jobs.fetch("sign-release")
    app_config = build_job.fetch("steps").find { |step| step.fetch("id", nil) == "app-config" }
    refute_nil app_config
    %w[app_id app_title app_build app_entry app_assets].each do |output|
      assert_equal "${{ steps.app-config.outputs.#{output} }}", build_job.fetch("outputs").fetch(output)
    end
    %w[app_id app_title app_build app_entry app_assets].each do |output|
      assert_includes sign_job.fetch("env").values.join("\n"),
                      "needs.build-test-package.outputs.#{output}"
    end

    build_script = build_job.fetch("steps")
      .find { |step| step.fetch("name") == "Check kernel and create Windows installers" }
      .fetch("run")
    sign_script = sign_job.fetch("steps")
      .find { |step| step.fetch("name") == "Create current app image for payload signing" }
      .fetch("run")
    properties = %w[
      dsxDesktopAppId
      dsxDesktopTitle
      dsxDesktopBuild
      dsxDesktopEntry
      dsxDesktopAssets
    ]
    properties.each do |property|
      assert_includes build_script, "-P#{property}="
      assert_includes sign_script, "-P#{property}="
      assert_equal 4, yaml.scan("-P#{property}=").length
    end
    assert_includes build_script, "@appProperties"
    assert_includes sign_script, "@appProperties"
    %w[ExpectedAppId ExpectedAppTitle ExpectedBuild ExpectedEntry ExpectedAssets].each do |parameter|
      assert_operator yaml.scan("-#{parameter} ").length, :>=, 4
    end
    refute_includes yaml, "DSX.exe"
    assert_includes yaml, "major/minor <= 255 and build <= 65535"
    assert_includes yaml, "'^[a-z0-9][a-z0-9.-]{1,127}$'"
    refute_includes yaml, "[a-z0-9._-]{0,127}"
    assert_includes yaml, "CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9]"
  end

  def test_release_signing_is_tag_and_environment_gated
    yaml = WORKFLOW.read(encoding: "UTF-8")
    assert_includes yaml, "startsWith(github.ref, 'refs/tags/v')"
    assert_includes yaml, "environment: windows-production"
    assert_includes yaml, "DSX_WINDOWS_SIGNING_PFX_BASE64"
    assert_includes yaml, "DSX_WINDOWS_SIGNING_PFX_PASSWORD"
    assert_includes yaml, "DSX_WINDOWS_SIGNING_CERT_SHA1"
    assert_includes yaml, ":desktop:createDistributable"
    assert_includes yaml, "windows-payload.json"
    assert_includes yaml, "attestations: write"
    assert_includes yaml, "id-token: write"
  end

  def test_artifact_verifier_is_fail_closed
    code = source("Verify-DsxWindowsArtifact.ps1")
    %w[.msi .exe SHA256 Get-AuthenticodeSignature TimeStamperCertificate
       ExpectedPublisherThumbprint Code\ Signing\ EKU].each do |marker|
      assert_includes code, marker.tr("\\", " ")
    end
    assert_includes code, "Exactly one MSI and one EXE artifact are required"
    assert_includes code, "dev.dsx.windows-artifacts/v1"
    assert_includes code, "applicationId = $canonicalAppId"
    assert_includes code, "product = $ExpectedAppTitle"
    assert_includes code, '$expectedBaseName = "$ExpectedAppTitle$expectedSuffix"'
    assert_includes code, "major/minor <= 255 and build <= 65535"
    assert_includes code, "UTF8Encoding]::new($false)"
    assert_includes code, "[ValidatePattern('^[A-Za-z0-9][A-Za-z0-9.-]{1,127}$')]"
    assert_includes code, "ExpectedAppTitle is not a portable Windows product/launcher name"
    assert_includes code, "wix-bootstrapper-i386"
    assert_includes code, "pe-x64"
    assert_includes code, "is ARM64, but this release lane is x64-only"
    refute_includes code, "@(0x014c, 0x8664, 0xaa64)"
    refute_match(/Invoke-Expression|\biex\b/i, code)
  end

  def test_install_smoke_always_uninstalls_and_checks_native_window
    code = source("Test-DsxWindowsInstall.ps1")
    assert_includes code, "finally"
    assert_includes code, "'/x', $productCode"
    assert_includes code, "--dsx-self-test-output"
    assert_includes code, "dev.dsx.desktop-self-test/v1"
    assert_includes code, "REINSTALLMODE=vomus"
    assert_includes code, "Assert-NativeLauncherArchitecture"
    assert_includes code, "Assert-NativePayloadArchitecture"
    assert_includes code, "Get-NativePeMachine"
    assert_includes code, "-AllowNonPe"
    assert_includes code, "Get-NativePayloadFiles"
    assert_includes code, "machine -ne 0x8664"
    assert_includes code, "PROCESSOR_ARCHITECTURE"
    assert_includes code, "Assert-SignedInstalledPayload"
    assert_includes code, "Get-DsxWindowsPackageEvidence"
    assert_includes code, "Assert-DsxWindowsPackageEvidenceMatch"
    assert_includes code, "dev.dsx.windows-payload/v2"
    assert_includes code, "Get-AuthenticodeSignature"
    assert_includes code, "Installed payload hash mismatch"
    assert_operator code.scan("Assert-SignedInstalledPayload `").length, :>=, 2
    assert_operator code.scan("Assert-NativePayloadArchitecture -ApplicationRoot").length, :>=, 3
    assert_includes code, "IsWindowVisible"
    assert_includes code, "GetWindowRect"
    assert_includes code, "-Filter $launcherName"
    assert_includes code, "productName -cne $ExpectedAppTitle"
    assert_includes code, "manifest.packageEvidence"
    assert_includes code, "Get-DesktopUpgradeUuid"
    assert_includes code, "MsiQueryProductState"
    assert_includes code, "INSTALLSTATE_UNKNOWN (-1)"
    assert_includes code, "Refusing to test MSI ProductCode"
    assert_includes code, '$installAttempted = $true'
    assert_includes code, 'installedProductState -notin @(3, 5)'
    assert_includes code, 'repairedProductState -notin @(3, 5)'
    assert_includes code, 'left ProductCode $productCode registered after uninstall'
    assert_includes code, "major/minor <= 255 and build <= 65535"
    assert_includes code, "[ValidatePattern('^[A-Za-z0-9][A-Za-z0-9.-]{1,127}$')]"
    assert_includes code, "ExpectedAppTitle is not a portable Windows product/launcher name"
    assert_includes code, "machine -ne 0x8664"
    refute_includes code, "Extension.ToLowerInvariant() -in @('.exe', '.dll')"
    refute_includes code, "-Filter 'DSX.exe'"
    refute_match(/Invoke-WebRequest|Invoke-RestMethod|Start-BitsTransfer/i, code)
  end

  def test_exe_lifecycle_is_fail_closed_and_exercises_every_transition
    code = EXE_LIFECYCLE.read(encoding: "UTF-8")

    %w[
      dev.dsx.windows-exe-lifecycle/v1 MsiEnumRelatedProducts
      MsiQueryProductState Get-DsxWindowsPackageEvidence
      Assert-DsxWindowsPackageEvidenceMatch Get-AuthenticodeSignature
      ExpectedPublisherThumbprint ExpectedSourceCommit ExpectedWorkflowRunId
      ExpectedWorkflowRunAttempt PreviousArtifactManifestPath
      CurrentArtifactManifestPath PreviousPayloadManifestPath
      CurrentPayloadManifestPath rollbackMode
      Assert-SourceProvenance GITHUB_RUN_ATTEMPT
      verified-current-exe-uninstall-then-previous-exe-reinstall
      relatedProductCount shortcutsRemoved launcherRemoved
    ].each { |marker| assert_includes code, marker }

    %w[
      previous-install previous-repair upgrade-current current-repair
      rollback-remove-current rollback-install-previous uninstall-previous
    ].each { |stage| assert_includes code, stage }
    assert_operator code.index("previous-install"), :<, code.index("previous-repair")
    assert_operator code.index("previous-repair"), :<, code.index("upgrade-current")
    assert_operator code.index("upgrade-current"), :<, code.index("current-repair")
    assert_operator code.index("current-repair"), :<, code.index("rollback-remove-current")
    assert_operator code.index("rollback-remove-current"), :<, code.index("rollback-install-previous")
    assert_operator code.index("rollback-install-previous"), :<, code.index("uninstall-previous")

    assert_includes code, "Refusing EXE lifecycle because upgrade family"
    assert_includes code, "Refusing EXE lifecycle because a target shortcut already exists"
    assert_includes code, "rev-parse HEAD"
    assert_includes code, "GitHub Actions provenance environment does not match"
    assert_includes code, '$lifecycleStarted = $false'
    assert_includes code, 'if ($lifecycleStarted)'
    assert_operator code.index("Refusing EXE lifecycle because a target shortcut already exists"), :<,
                    code.index('$lifecycleStarted = $true')
    assert_operator code.index('$lifecycleStarted = $true'), :<,
                    code.index("-Stage 'previous-install'")
    assert_includes code, "@('uninstall')"
    assert_includes code, "REINSTALL=ALL"
    assert_includes code, "REINSTALLMODE=vamus"
    assert_includes code, "CorruptionCanary"
    assert_includes code, "Flush($true)"
    assert_includes code, "repair did not restore the deliberately damaged payload"
    assert_includes code, "did not replace the previous ProductCode"
    assert_includes code, "Rollback reinstall did not restore the original previous ProductCode"
    assert_includes code, "Assert-NoLifecycleResidue"
    assert_includes code, "Refusing emergency removal of unrecognized related product"
    assert_includes code, "FileMode]::CreateNew"
    assert_includes code, "ArgumentList.Add"
    assert_includes code, "app upgrade family contains too many"
    assert_includes code, "Installed native payload has non-x64 machine"
    assert_includes code, "Artifact manifest must bind exactly one MSI and one EXE"
    assert_includes code, "Installed payload file count"
    assert_includes code, "NormalizationForm]::FormC"
    assert_includes code, "GetInvalidFileNameChars"
    assert_includes code, "CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9]"
    assert_includes code, "Installed native signature does not match the payload manifest"
    assert_includes code, "installer bytes changed during lifecycle execution"
    refute_match(/Invoke-WebRequest|Invoke-RestMethod|Start-BitsTransfer|Invoke-Expression|\biex\b/i, code)
    refute_includes code, "Set-AuthenticodeSignature"
    refute_includes code, "-ExecutionPolicy Bypass"
  end

  def test_workflow_runs_unsigned_and_signed_exe_lifecycles_and_retains_evidence
    yaml = WORKFLOW.read(encoding: "UTF-8")
    parsed = YAML.safe_load(yaml, aliases: false)
    jobs = parsed.fetch("jobs")

    build = jobs.fetch("build-test-package")
    sign = jobs.fetch("sign-release")
    assert_equal 60, build.fetch("timeout-minutes")
    assert_equal 60, sign.fetch("timeout-minutes")
    assert_equal "${{ steps.version.outputs.previous_version }}", build.fetch("outputs").fetch("previous_version")
    assert_equal "${{ steps.version.outputs.previous_build }}", build.fetch("outputs").fetch("previous_build")
    assert_equal 2, yaml.scan("Test-DsxWindowsExeLifecycle.ps1").length
    assert_equal 2, yaml.scan("-ExpectedSourceCommit \"${{ github.sha }}\"").length
    assert_equal 2, yaml.scan("-ExpectedWorkflowRunId \"${{ github.run_id }}\"").length
    assert_equal 2, yaml.scan("-ExpectedWorkflowRunAttempt \"${{ github.run_attempt }}\"").length
    assert_includes yaml, "Version 0.0.0 cannot prove an ordered Windows upgrade and rollback lifecycle"
    assert_includes yaml, "lifecycle-prev-$env:GITHUB_RUN_ID"
    assert_includes yaml, "Create previous-version EXE lifecycle fixture"
    assert_includes yaml, "Sign previous-version EXE lifecycle fixture"
    assert_includes yaml, "Exercise signed EXE install, repair, upgrade, rollback, and uninstall"
    assert_includes yaml, "-PreviousArtifactManifestPath"
    assert_includes yaml, "-CurrentArtifactManifestPath"
    assert_includes yaml, "-PreviousPayloadManifestPath"
    assert_includes yaml, "-CurrentPayloadManifestPath"
    assert_includes yaml, "windows-exe-lifecycle-unsigned.json"
    assert_includes yaml, "windows-signed/windows-exe-lifecycle.json"
    assert_includes yaml, "windows-signed-previous/*.exe"
    assert_includes yaml, "windows-desktop-signed-lifecycle-fixture-"
    assert_includes yaml, "retention-days: 7"
    assert_operator yaml.index("Create previous-version app image for signed EXE lifecycle"), :<,
                    yaml.index("Create current app image for payload signing")
    assert_operator yaml.index("Exercise signed EXE install, repair, upgrade, rollback, and uninstall"), :<,
                    yaml.index("Attest signed binaries and digest manifest")
  end

  def test_signer_keeps_password_off_child_process_command_line_and_cleans_up
    code = source("Sign-DsxWindowsArtifacts.ps1")
    assert_includes code, "Import-PfxCertificate"
    assert_includes code, "-Exportable:$false"
    assert_includes code, "4 MiB encoded limit"
    assert_includes code, '$privateCertificates.Count -ne 1'
    assert_includes code, "must import exactly one private signing identity"
    assert_includes code, '$certificate.NotBefore.ToUniversalTime() -gt $now'
    assert_includes code, '$certificate.NotAfter.ToUniversalTime() -le $now'
    assert_includes code, "'/fd', 'SHA256'"
    assert_includes code, "'/td', 'SHA256'"
    assert_includes code, "'/tr', $TimestampUrl"
    assert_includes code, "dev.dsx.windows-payload/v2"
    assert_includes code, "Get-DsxWindowsPackageEvidence"
    assert_includes code, "packageEvidence = $PackageEvidence"
    assert_includes code, "--app-image"
    assert_includes code, "--win-upgrade-uuid"
    assert_includes code, "Get-DesktopUpgradeUuid"
    assert_includes code, '"dev.dsx.desktop:$CanonicalAppId"'
    assert_includes code, "System.Security.Cryptography.MD5"
    assert_includes code, "uuidBytes[6] -band 0x0f"
    assert_includes code, "uuidBytes[8] -band 0x3f"
    assert_includes code, "--name', $ExpectedAppTitle"
    assert_includes code, "-Filter $launcherName"
    refute_includes code, "entry = $ExpectedEntry"
    refute_includes code, "assets = $ExpectedAssets"
    assert_includes code, "major/minor <= 255 and build <= 65535"
    assert_includes code, "[ValidatePattern('^[A-Za-z0-9][A-Za-z0-9.-]{1,127}$')]"
    assert_includes code, "ExpectedAppTitle is not a portable Windows product/launcher name"
    assert_includes code, "Get-DsxPeMachineOrNull"
    assert_includes code, "AppImage native payload"
    bytes = Digest::MD5.digest("dev.dsx.desktop:dev.dsx.runtime").bytes
    bytes[6] = (bytes[6] & 0x0f) | 0x30
    bytes[8] = (bytes[8] & 0x3f) | 0x80
    hex = bytes.pack("C*").unpack1("H*")
    expected_upgrade_uuid = [hex[0, 8], hex[8, 4], hex[12, 4], hex[16, 4], hex[20, 12]].join("-")
    refute_includes code, expected_upgrade_uuid, "the signer must derive, not hard-code, the app UUID"
    assert_includes ROOT.join("OpenSource/Engine/Android/desktop/build.gradle.kts").read,
                    '"dev.dsx.desktop:$desktopCanonicalAppId"'
    assert_operator code.index("foreach ($native in $nativeFiles)"), :<, code.index("Invoke-JpackageInstaller -Jpackage")
    assert_includes code, "finally"
    assert_includes code, "Cert:\\CurrentUser\\My\\$thumbprint"
    assert_includes code, "$password.Dispose()"
    assert_includes code, "-ErrorAction Stop"
    refute_match(/\/p['\"\s,]/i, code, "PFX password must never be passed to signtool")
  end

  def test_package_evidence_comes_from_launcher_cfg_and_classpath_jars
    code = source("Get-DsxWindowsPackageEvidence.ps1")

    assert_includes code, "dev.dsx.windows-package-evidence/v1"
    assert_includes code, %q{Join-Path 'app' "$ExpectedAppTitle.cfg"}
    assert_includes code, "Read-DsxLauncherConfiguration"
    assert_includes code, "System.Text.UTF8Encoding]::new($false, $true)"
    assert_includes code, "dsx.app.id"
    assert_includes code, "dsx.app.title"
    assert_includes code, "dsx.app.version"
    assert_includes code, "jpackage.app-version"
    assert_includes code, "dsx.app.build"
    assert_includes code, "dsx.app.identity.locked"
    assert_includes code, "dsx.app.entry.resource"
    assert_includes code, '$_.value -ceq $propertyOption'
    assert_includes code, 'defines $Name more than once'
    assert_includes code, "identityLocked = $true"
    assert_includes code, "System.IO.Compression.ZipFile]::OpenRead"
    assert_includes code, "dsx/AppIdentity.properties"
    assert_includes code, "dsx.identity.schema=dev.dsx.desktop-app-identity/v1"
    assert_includes code, "dsx.app.assets.prefix"
    assert_includes code, "exact LF-only build-owned identity contract"
    assert_includes code, "dsx/AppEntry.dsx"
    assert_includes code, "dsx/app-assets/"
    assert_includes code, "classpathJar ="
    assert_includes code, "Packaged DSX resource is shadowed"
    assert_includes code, "Assert-DsxResourceInventory"
    assert_includes code, "sha256 ="
    assert_includes code, "configurationSha256 ="
    assert_includes code, "Installed launcher configuration or packaged DSX resource evidence differs"
    assert_includes code, "exactly one canonical DSX app.mainclass"
    assert_includes code, "despia.engine.desktop.DesktopHostKt"
    assert_includes code, "must not define app.mainjar"
    assert_includes code, "must not define app.mainmodule"
    assert_includes code, "canonical app.classpath records"
    assert_includes code, "canonical main-JAR, main-class, dependency-classpath sequence"
    assert_includes code, "one canonical `$APPDIR\\ JAR reference"
    assert_includes code, "contains a duplicate JAR reference"
    assert_includes code, "forbidden classpath override"
    assert_includes code, "-Djava\\.class\\.path"
    assert_includes code, "Assert-DsxExactJavaOptions"
    assert_includes code, "-Dcompose.application.configure.swing.globals=true"
    assert_includes code, '-Dskiko.library.path=$APPDIR'
    assert_includes code, "does not match the canonical count"
    assert_includes code, "missing or duplicates a canonical option"
    assert_includes code, "contains an additional startup option"
    assert_includes code, "despia/engine/desktop/DesktopHostKt.class"
    assert_includes code, "Assert-DsxDesktopMainClassOwnership"
    assert_includes code, "Assert-DsxJarManifestDoesNotExtendClasspath"
    assert_includes code, "OrdinalIgnoreCase"
    assert_includes code, "manifest must not define Class-Path"
    refute_match(/Invoke-WebRequest|Invoke-RestMethod|Start-BitsTransfer|Invoke-Expression|\biex\b/i, code)
  end

  def test_portable_package_evidence_probe_covers_launcher_and_classpath_tampering
    probe = PACKAGE_EVIDENCE_PROBE.read(encoding: "UTF-8")
    %w[
      missing\ main\ class wrong\ main\ class duplicate\ main\ class main\ JAR\ override
      main\ module\ override noncanonical\ application\ order
      semicolon\ classpath wildcard\ classpath forward-slash\ classpath
      duplicate\ classpath\ JAR main-class\ shadowing dependency\ owns\ main\ class
      missing\ Compose\ globals\ option missing\ Skiko\ path\ option
      duplicate\ canonical\ Java\ option continued\ mixed-case\ manifest\ Class-Path
    ].each { |tamper| assert_includes probe, tamper.tr("\\", " ") }
    %w[-cp -classpath --class-path -Djava.class.path].each do |override|
      assert_includes probe, override
    end
    %w[-javaagent -agentpath -Xbootclasspath --patch-module].each do |startup_injection|
      assert_includes probe, startup_injection
    end

    candidates = [ENV["DSX_PWSH"]]
    ENV.fetch("PATH", "").split(File::PATH_SEPARATOR).each do |directory|
      candidates << File.join(directory, "pwsh")
      candidates << File.join(directory, "pwsh.exe")
    end
    pwsh = candidates.compact.find { |candidate| File.file?(candidate) && File.executable?(candidate) }
    skip "PowerShell 7 is not installed on this audit host" unless pwsh

    stdout, stderr, status = Open3.capture3(
      pwsh, "-NoLogo", "-NoProfile", "-File", PACKAGE_EVIDENCE_PROBE.to_s,
      chdir: ROOT.to_s
    )
    assert status.success?, "package evidence probe failed:\n#{stdout}\n#{stderr}"
    assert_includes stdout, "DSX Windows package evidence probe passed"
  end

  def test_release_readiness_guards_the_package_evidence_verifier
    readiness = JSON.parse(ROOT.join("ClosedSource/release/release-readiness.json").read)
    windows = readiness.fetch("ui_matrix").find { |target| target.fetch("id") == "windows-desktop" }
    refute_nil windows
    assert_includes windows.fetch("files_all"),
                    "OpenSource/Engine/Android/desktop/windows/Get-DsxWindowsPackageEvidence.ps1"
    assert_includes windows.fetch("files_all"),
                    "OpenSource/Engine/Android/desktop/windows/Test-DsxWindowsExeLifecycle.ps1"
    assert_includes windows.fetch("source_markers_all"), "dev.dsx.windows-payload/v2"
    assert_includes windows.fetch("source_markers_all"), "dev.dsx.windows-package-evidence/v1"
    assert_includes windows.fetch("source_markers_all"), "dev.dsx.windows-exe-lifecycle/v1"
    assert_includes windows.fetch("source_markers_all"), "MsiEnumRelatedProducts"
    assert_includes windows.fetch("source_markers_all"), "dsx/AppIdentity.properties"
  end
end
