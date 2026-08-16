#!/usr/bin/env ruby
# frozen_string_literal: true

require "fileutils"
require "digest"
require "json"
require "minitest/autorun"
require "open3"
require "tmpdir"
require "yaml"

class LinuxReleaseGuardsTest < Minitest::Test
  ROOT = File.expand_path("../../../../..", __dir__)
  VERIFIER = File.join(__dir__, "verify-linux-package.sh")
  SIGNING_INPUT_VERIFIER = File.join(__dir__, "verify-linux-signing-inputs.sh")
  RELEASE_VERIFIER = File.join(__dir__, "verify-linux-release.py")
  PUBLIC_VALIDATION_WORKFLOW = File.join(ROOT, ".github/workflows/linux-desktop-validation.yml")
  CODEMAGIC = File.join(ROOT, "codemagic.yaml")
  TRUST_KEY = File.join(ROOT, "ClosedSource/release/linux-signing-public-key.asc")
  TRUST_POLICY = File.join(ROOT, "ClosedSource/release/linux-signing-trust.json")
  HOST_CLASS = "despia/engine/desktop/DesktopHostKt.class"
  APP_ID = "dev.dsx.runtime"
  TITLE = "DSX"
  VERSION = "1.2.3"
  BUILD = "guard-42"

  def setup
    skip "python3 is required for Linux release guards" unless system("python3", "--version", out: File::NULL, err: File::NULL)
  end

  def verifier_python
    source = File.read(VERIFIER, encoding: "UTF-8")
    body = source.split("<<'PY'\n", 2).fetch(1).split("\nPY\n", 2).fetch(0)
    assert_includes body, "launcher classpath must contain exactly one"
    body
  end

  def identity
    [
      "dsx.identity.schema=dev.dsx.desktop-app-identity/v1",
      "dsx.app.id=#{APP_ID}",
      "dsx.app.title=#{TITLE}",
      "dsx.app.version=#{VERSION}",
      "dsx.app.build=#{BUILD}",
      "dsx.app.identity.locked=true",
      "dsx.app.entry.resource=",
      "dsx.app.assets.prefix="
    ].join("\n") + "\n"
  end

  def write_fake_elf(path)
    bytes = "\0".b * 64
    bytes[0, 7] = "\x7fELF\x02\x01\x01".b
    bytes.setbyte(18, 62)
    bytes.setbyte(19, 0)
    File.binwrite(path, bytes)
    File.chmod(0o755, path)
  end

  def write_jar(path, include_host: true, include_identity: true,
                versioned_host: false, manifest_classpath: false)
    script = <<~'PY'
      import pathlib
      import sys
      import zipfile

      destination = pathlib.Path(sys.argv[1])
      identity = pathlib.Path(sys.argv[2]).read_bytes()
      include_host = sys.argv[3] == "1"
      include_identity = sys.argv[4] == "1"
      versioned_host = sys.argv[5] == "1"
      manifest_classpath = sys.argv[6] == "1"
      with zipfile.ZipFile(destination, "w", compression=zipfile.ZIP_STORED) as archive:
          if manifest_classpath:
              archive.writestr("META-INF/MANIFEST.MF", "Manifest-Version: 1.0\r\nClass-Path: evil.jar\r\n\r\n")
          if include_identity:
              archive.writestr("dsx/AppIdentity.properties", identity)
          if include_host:
              archive.writestr("despia/engine/desktop/DesktopHostKt.class", b"synthetic-host")
          if versioned_host:
              archive.writestr(
                  "META-INF/versions/21/despia/engine/desktop/DesktopHostKt.class",
                  b"synthetic-versioned-shadow",
              )
    PY
    identity_path = File.join(File.dirname(path), "identity.txt")
    File.binwrite(identity_path, identity)
    _stdout, stderr, status = Open3.capture3(
      "python3", "-c", script, path, identity_path,
      include_host ? "1" : "0", include_identity ? "1" : "0",
      versioned_host ? "1" : "0", manifest_classpath ? "1" : "0"
    )
    assert status.success?, stderr
  end

  def run_synthetic_verifier(java_options: [], application_lines: [], executable_decoy: false,
                             second_host_jar: false, versioned_host_jar: false,
                             manifest_classpath: false, omit_java_options: [],
                             omit_runtime: false)
    Dir.mktmpdir("dsx-linux-release-guard") do |temporary|
      repository = File.join(temporary, "repository")
      root = File.join(temporary, "root")
      app_root = File.join(root, "opt", "dsx")
      bin_dir = File.join(app_root, "bin")
      config_dir = File.join(app_root, "lib", "app")
      runtime_root = File.join(app_root, "lib", "runtime")
      runtime_lib = File.join(runtime_root, "lib")
      runtime_server = File.join(runtime_lib, "server")
      FileUtils.mkdir_p([repository, bin_dir, config_dir, File.join(root, "share")])

      launcher = File.join(bin_dir, TITLE)
      write_fake_elf(launcher)
      # Compose strips the runtime's native launchers (bin/java, ...); the pinned
      # JVM is proven by its load-bearing image: the versioned release manifest,
      # the module image, and the JVM shared library.
      unless omit_runtime
        FileUtils.mkdir_p(runtime_server)
        File.write(File.join(runtime_root, "release"), %(JAVA_VERSION="21.0.10"\n), mode: "wb")
        File.write(File.join(runtime_lib, "modules"), "synthetic-jimage\n", mode: "wb")
        # The JDK-owned runtime configuration must not be mistaken for the launcher cfg.
        File.write(File.join(runtime_lib, "jvm.cfg"), "-server KNOWN\n", mode: "wb")
        write_fake_elf(File.join(runtime_server, "libjvm.so"))
      end
      write_jar(File.join(config_dir, "desktop.jar"), manifest_classpath: manifest_classpath)

      classpath_lines = ["app.classpath=$APPDIR/desktop.jar"]
      if second_host_jar
        write_jar(File.join(config_dir, "shadow.jar"), include_identity: false)
        classpath_lines << "app.classpath=$APPDIR/shadow.jar"
      end
      if versioned_host_jar
        write_jar(
          File.join(config_dir, "versioned-shadow.jar"),
          include_host: false,
          include_identity: false,
          versioned_host: true
        )
        classpath_lines << "app.classpath=$APPDIR/versioned-shadow.jar"
      end
      application = classpath_lines + ["app.mainclass=despia.engine.desktop.DesktopHostKt"] + application_lines
      options = [
        "-Djpackage.app-version=#{VERSION}",
        "-Dcompose.application.resources.dir=$APPDIR/resources",
        "-Dcompose.application.configure.swing.globals=true",
        "-Ddsx.app.id=#{APP_ID}",
        "-Ddsx.app.title=#{TITLE}",
        "-Ddsx.app.version=#{VERSION}",
        "-Ddsx.app.build=#{BUILD}",
        "-Ddsx.app.identity.locked=true",
        "-Dskiko.library.path=$APPDIR"
      ].reject { |option| omit_java_options.include?(option) } + java_options
      configuration = [
        "[Application]",
        *application,
        "[JavaOptions]",
        *options.map { |option| "java-options=#{option}" },
        ""
      ].join("\n")
      File.write(File.join(config_dir, "#{TITLE}.cfg"), configuration, mode: "wb")

      if executable_decoy
        decoy = File.join(bin_dir, "Diagnostics")
        File.write(decoy, "#!/bin/sh\nexit 0\n", mode: "wb")
        File.chmod(0o755, decoy)
      end
      7.times { |index| File.write(File.join(root, "share", "padding-#{index}"), "guard\n") }

      python_path = File.join(temporary, "verify-tree.py")
      File.write(python_path, verifier_python, mode: "wb")
      Open3.capture3(
        "python3", python_path, root, launcher, "0", TITLE, repository,
        "", "", APP_ID, VERSION, BUILD
      )
    end
  end

  def assert_verifier_rejects(message, **options)
    _stdout, stderr, status = run_synthetic_verifier(**options)
    refute status.success?, "synthetic package unexpectedly passed"
    assert_includes stderr, message
  end

  def test_canonical_synthetic_package_passes
    stdout, stderr, status = run_synthetic_verifier
    assert status.success?, stderr
    assert_equal "dev.dsx.linux-payload-truth/v1", JSON.parse(stdout).fetch("schema")
  end

  def test_every_effective_classpath_override_form_fails_closed
    [
      "-cp /tmp/evil.jar",
      "-cp=/tmp/evil.jar",
      "-classpath /tmp/evil.jar",
      "-classpath=/tmp/evil.jar",
      "--class-path=/tmp/evil.jar",
      "-Djava.class.path=/tmp/evil.jar",
      "-Xbootclasspath/a:/tmp/evil.jar"
    ].each do |option|
      assert_verifier_rejects("may not override the verified classpath", java_options: [option])
    end
  end

  def test_complete_java_options_multiset_rejects_startup_injection_omission_and_duplicates
    [
      "-javaagent:/tmp/evil.jar",
      "-agentpath:/tmp/evil.so",
      "--patch-module=java.base=/tmp/evil.jar",
      "-Djava.system.class.loader=EvilLoader",
      "-XX:OnError=/tmp/evil"
    ].each do |option|
      assert_verifier_rejects(
        "do not exactly match the pinned Compose/jpackage contract",
        java_options: [option]
      )
    end
    assert_verifier_rejects(
      "do not exactly match the pinned Compose/jpackage contract",
      omit_java_options: ["-Dcompose.application.configure.swing.globals=true"]
    )
    assert_verifier_rejects(
      "do not exactly match the pinned Compose/jpackage contract",
      java_options: ["-Dskiko.library.path=$APPDIR"]
    )
  end

  def test_alternate_startup_and_host_shadowing_fail_closed
    assert_verifier_rejects(
      "forbidden startup key: app.mainjar",
      application_lines: ["app.mainjar=$APPDIR/evil.jar"]
    )
    assert_verifier_rejects("must contain exactly one #{HOST_CLASS}", second_host_jar: true)
    assert_verifier_rejects("must contain exactly one #{HOST_CLASS}", versioned_host_jar: true)
    assert_verifier_rejects(
      "may not extend the verified classpath through its manifest",
      manifest_classpath: true
    )
  end

  def test_noncanonical_or_duplicate_cfg_classpath_records_fail_closed
    [
      "app.classpath=$APPDIR/*.jar",
      "app.classpath=$APPDIR/desktop.jar;evil.jar",
      "app.classpath=$APPDIR/desktop.jar:$APPDIR/evil.jar"
    ].each do |line|
      assert_verifier_rejects("unsafe or non-canonical classpath entry", application_lines: [line])
    end
    assert_verifier_rejects(
      "duplicate launcher classpath archive",
      application_lines: ["app.classpath=$APPDIR/desktop.jar"]
    )
  end

  def test_additional_executable_in_app_bin_fails_closed
    assert_verifier_rejects(
      "app/bin must contain only the canonical executable launcher",
      executable_decoy: true
    )
  end

  def test_missing_pinned_jvm_runtime_fails_closed
    assert_verifier_rejects(
      "package does not contain its canonical pinned JVM runtime",
      omit_runtime: true
    )
  end

  def test_signing_input_gate_rejects_stale_or_augmented_inventory
    Dir.mktmpdir("dsx-linux-signing-guard") do |temporary|
      deb = File.join(temporary, "DSX.deb")
      rpm = File.join(temporary, "DSX.rpm")
      inventory = File.join(temporary, "linux-package-sha256.txt")
      safe_tmp = File.join(temporary, "private-tmp")
      FileUtils.mkdir_p(safe_tmp)
      FileUtils.chmod(0o700, safe_tmp)
      File.binwrite(deb, "verified deb\n")
      File.binwrite(rpm, "verified rpm\n")
      checksums, checksum_error, checksum_status = Open3.capture3("sha256sum", "--", deb, rpm)
      assert checksum_status.success?, checksum_error
      File.binwrite(inventory, checksums)

      environment = { "TMPDIR" => safe_tmp }
      _stdout, stderr, status = Open3.capture3(environment, SIGNING_INPUT_VERIFIER, inventory, deb, rpm)
      assert status.success?, stderr
      assert_empty Dir.glob(File.join(safe_tmp, "dsx-linux-current-sha256.*"))

      File.binwrite(deb, "changed after verification\n")
      _stdout, stderr, status = Open3.capture3(environment, SIGNING_INPUT_VERIFIER, inventory, deb, rpm)
      refute status.success?
      assert_includes stderr, "differ from the verified checksum inventory"

      fresh, checksum_error, checksum_status = Open3.capture3("sha256sum", "--", deb, rpm)
      assert checksum_status.success?, checksum_error
      File.binwrite(inventory, fresh + "unexpected record\n")
      _stdout, stderr, status = Open3.capture3(environment, SIGNING_INPUT_VERIFIER, inventory, deb, rpm)
      refute status.success?
      assert_includes stderr, "differ from the verified checksum inventory"

      unsafe_tmp = File.join(temporary, "tmp-link")
      File.symlink(safe_tmp, unsafe_tmp)
      _stdout, stderr, status = Open3.capture3(
        { "TMPDIR" => unsafe_tmp }, SIGNING_INPUT_VERIFIER, inventory, deb, rpm
      )
      refute status.success?
      assert_includes stderr, "temporary root validation failed"
    end
  end

  def test_deb_and_rpm_system_lifecycles_are_both_fail_closed
    verifier = File.read(VERIFIER, encoding: "UTF-8")

    assert_includes verifier, 'deb_install_attempted=1'
    assert_includes verifier, 'rpm_install_attempted=1'
    assert_includes verifier, 'dpkg --install "$deb"'
    assert_includes verifier, 'dpkg --purge "$expected_package"'
    assert_includes verifier, 'rpm --install --nodeps "$rpm_file"'
    assert_includes verifier, 'rpm --verify --nodeps "$expected_package"'
    assert_includes verifier, 'rpm --erase --nodeps "$expected_package"'
    assert_includes verifier, 'inventory_installed_package_elf rpm'
    assert_includes verifier, 'rpm-installed-self-test.json'
    assert_operator verifier.scan('verify_installed_ui "$').length, :>=, 2
    assert_includes verifier, 'RPM-installed launcher survived package erase'
    assert_includes verifier, 'emergency rpm erase failed'
    assert_includes verifier, "trap 'exit 130' INT"
    assert_includes verifier, "trap 'exit 143' TERM"
  end

  def test_linux_signer_is_secret_isolated_staged_and_rollback_safe
    signer = File.read(File.join(__dir__, "sign-linux-artifacts.sh"), encoding: "UTF-8")

    executable_lines = signer.lines.reject { |line| line.start_with?("#") || line.strip.empty? }
    assert_equal "set +x\n", executable_lines.first
    assert_includes signer, 'unset DSX_LINUX_SIGNING_PRIVATE_KEY_B64 DSX_LINUX_SIGNING_KEY_FINGERPRINT'
    assert_includes signer, 'key material must contain exactly one primary secret key'
    assert_includes signer, '--digest-algo SHA256'
    assert_includes signer, '--no-auto-key-retrieve'
    assert_includes signer, '$10 == "8"'
    assert_includes signer, 'publish_complete=0'
    assert_includes signer, 'failed to roll back partial output'
    assert_includes signer, 'private signing workspace cleanup failed'
    assert_includes signer, 'safe_tmp_root="${TMPDIR:-/tmp}"'
    assert_includes signer, 'refused unsafe rollback path'
    assert_includes signer, 'gpgconf --homedir "$gpg_home" --kill all'
    assert_includes signer, 'failed to terminate isolated GnuPG agents'
    assert_includes signer, 'verify-linux-release.py'
    assert_includes signer, 'mkdir -m 700 -- "$sign_home" "$verify_home" "$stage_dir"'
    assert_includes signer, 'normalize_public_repository "$stage_repository"'
    assert_includes signer, 'find -P "$root" -xdev -type d -exec chmod 0755 -- {} +'
    assert_includes signer, 'find -P "$root" -xdev -type f -exec chmod 0644 -- {} +'
    refute_includes signer, 'chmod -R'
    assert_operator signer.index('unset DSX_LINUX_SIGNING_PRIVATE_KEY_B64'), :<,
                    signer.index('printf \'%s\' "$private_key_b64" | base64 --decode')
    assert_operator signer.index('sign_clearsigned "$apt_release" "$apt_inrelease"'), :<,
                    signer.index('normalize_public_repository "$stage_repository"')
    assert_operator signer.index('normalize_public_repository "$stage_repository"'), :<,
                    signer.index('stage_provenance="$stage_reports/linux-release-provenance.json"')
    assert_operator signer.index('mv -- "$stage_provenance" "$provenance"'), :<,
                    signer.index('publish_complete=1')
  end

  def test_public_validation_and_protected_tag_signing_are_separate_credential_boundaries
    public_workflow = File.read(PUBLIC_VALIDATION_WORKFLOW, encoding: "UTF-8")
    github = YAML.safe_load(
      public_workflow,
      permitted_classes: [], permitted_symbols: [], aliases: false
    )
    codemagic = YAML.safe_load(
      File.read(CODEMAGIC, encoding: "UTF-8"),
      permitted_classes: [], permitted_symbols: [], aliases: false
    )
    release = codemagic.fetch("workflows").fetch("desktop-linux-release")

    assert_match(/^  pull_request:\s*$/m, public_workflow)
    refute_includes public_workflow, "pull_request_target"
    assert_match(/^    branches: \[main\]\s*$/m, public_workflow)
    refute_match(/^    tags:/m, public_workflow)
    refute_includes public_workflow, "${{ secrets."
    refute_match(/^\s+environment:\s*\S/m, public_workflow)
    refute_includes public_workflow, "sign-linux-artifacts.sh"
    assert_includes public_workflow, "cache-read-only: true"
    assert_includes public_workflow, "persist-credentials: false"
    assert_equal({ "contents" => "read" }, github.fetch("permissions"))
    refute github.fetch("permissions").key?("id-token")

    assert_equal ["tag"], release.fetch("triggering").fetch("events")
    refute release.fetch("triggering").key?("branch_patterns")
    assert_equal ["dsx_linux_release_credentials"], release.fetch("environment").fetch("groups")
    release_variables = release.fetch("environment").fetch("vars")
    refute release_variables.keys.any? { |name| name.start_with?("DSX_LINUX_SIGNING_") }
    first_step = release.fetch("scripts").first
    assert_equal "Admit exact tag source before any generation", first_step.fetch("name")
    assert_includes first_step.fetch("script"), "verify_release_source_state.rb"
    assert_includes first_step.fetch("script"), "CM_PULL_REQUEST:-false"
    assert_includes release.fetch("scripts").last.fetch("script"), "sign-linux-artifacts.sh"
  end

  def test_pinned_public_key_repository_metadata_and_provenance_verifier_are_fail_closed
    policy = JSON.parse(File.read(TRUST_POLICY, encoding: "UTF-8"))
    key = File.binread(TRUST_KEY)
    verifier = File.read(RELEASE_VERIFIER, encoding: "UTF-8")
    signer = File.read(File.join(__dir__, "sign-linux-artifacts.sh"), encoding: "UTF-8")

    assert_equal "dev.dsx.linux-signing-trust/v1", policy.fetch("schema")
    assert_equal "active", policy.fetch("status")
    assert_match(/\A[0-9A-F]{40}\z/, policy.fetch("primaryFingerprint"))
    assert_equal Digest::SHA256.hexdigest(key), policy.fetch("publicKeySha256")
    assert_includes key, "BEGIN PGP PUBLIC KEY BLOCK"
    refute_includes key, "PRIVATE KEY"

    %w[
      --no-auto-key-retrieve
      import-minimal
      VALIDSIG
      REVKEYSIG
      linux-release-provenance/v1
      validate_apt_repository
      validate_rpm_repository
      validate_source_admission
      validate_public_repository_tree
    ].each { |marker| assert_includes verifier, marker }
    assert_includes verifier, "apt InRelease"
    assert_includes verifier, "rpm repomd.xml"
    assert_includes signer, "apt-ftparchive packages pool"
    assert_includes signer, "createrepo_c --quiet --no-database --checksum sha256"
    assert_includes signer, 'sign_clearsigned "$apt_release" "$apt_inrelease"'
    assert_includes signer, 'sign_detached "$rpm_repomd" "$rpm_repomd_signature"'
    assert_includes signer, '"$apt_inrelease|$stage_repository/apt/dists/stable/InRelease"'
    assert_includes signer, 'normalize_public_repository "$stage_repository"'
    assert_includes verifier, "| apt_signature_files"
    assert_includes verifier, "| rpm_signature_files"
    assert_includes signer, '"$release_verifier"'
  end
end
