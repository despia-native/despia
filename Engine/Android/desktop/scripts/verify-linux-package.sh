#!/usr/bin/env bash
# Production verifier for DSX's Linux Compose distributions. Run on a native
# Linux CI host after :desktop:packageDeb and :desktop:packageRpm.
set -euo pipefail

if [[ "$(uname -s)" != "Linux" ]]; then
  echo "verify-linux-package: a native Linux host is required" >&2
  exit 2
fi

for tool in dpkg-deb dpkg-query rpm rpm2cpio cpio python3 sha256sum sudo xvfb-run xwininfo timeout; do
  command -v "$tool" >/dev/null 2>&1 || {
    echo "verify-linux-package: missing required tool: $tool" >&2
    exit 2
  }
done

desktop_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
build_dir="$desktop_dir/build"
deb_dir="$build_dir/compose/binaries/main/deb"
rpm_dir="$build_dir/compose/binaries/main/rpm"
report_dir="$build_dir/reports"
repository_dir="$(cd "$desktop_dir/../../../.." && pwd -P)"
mkdir -p "$report_dir"

expected_version="${DSX_DESKTOP_VERSION:?DSX_DESKTOP_VERSION is required}"
expected_release="${DSX_DESKTOP_RELEASE:?DSX_DESKTOP_RELEASE is required}"
raw_app_id="${DSX_DESKTOP_APP_ID:-dev.dsx.runtime}"
expected_app_id="${raw_app_id,,}"
expected_package="$expected_app_id"
expected_title="${DSX_DESKTOP_TITLE:-DSX}"
expected_build="${DSX_DESKTOP_BUILD:-$expected_version}"
expected_entry="${DSX_DESKTOP_ENTRY:-}"
expected_assets="${DSX_DESKTOP_ASSETS:-}"
[[ "${DSX_LINUX_INSTALL_SMOKE:-}" == "1" ]] || {
  echo "verify-linux-package: DSX_LINUX_INSTALL_SMOKE=1 is required for the destructive ephemeral-runner install gate" >&2
  exit 2
}
[[ "$expected_version" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]] || {
  echo "verify-linux-package: invalid expected version: $expected_version" >&2
  exit 2
}
IFS=. read -r version_major version_minor version_build <<< "$expected_version"
if (( ${#version_major} > 3 || ${#version_minor} > 3 || ${#version_build} > 5 )) ||
   (( 10#$version_major > 255 || 10#$version_minor > 255 || 10#$version_build > 65535 )); then
  echo "verify-linux-package: version exceeds portable caps (255.255.65535): $expected_version" >&2
  exit 2
fi
[[ "$expected_release" =~ ^[1-9][0-9]*$ ]] || {
  echo "verify-linux-package: invalid expected release: $expected_release" >&2
  exit 2
}
[[ "$raw_app_id" =~ ^[A-Za-z0-9][A-Za-z0-9.-]{1,127}$ &&
   "$expected_package" =~ ^[a-z0-9][a-z0-9.-]{1,127}$ ]] || {
  echo "verify-linux-package: invalid app ID: $raw_app_id" >&2
  exit 2
}
[[ "$expected_title" =~ ^[A-Za-z0-9]([A-Za-z0-9\ ._-]{0,62}[A-Za-z0-9._-])?$ ]] || {
  echo "verify-linux-package: invalid app title" >&2
  exit 2
}
title_lower="${expected_title,,}"
[[ "$expected_title" != *. &&
   ! "$title_lower" =~ ^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$ ]] || {
  echo "verify-linux-package: app title is not portable across desktop package targets" >&2
  exit 2
}
[[ "$expected_build" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$ ]] || {
  echo "verify-linux-package: invalid app build identifier" >&2
  exit 2
}

mapfile -t debs < <(find "$deb_dir" -maxdepth 1 -type f -name '*.deb' -print | sort)
mapfile -t rpms < <(find "$rpm_dir" -maxdepth 1 -type f -name '*.rpm' -print | sort)
[[ ${#debs[@]} -eq 1 ]] || { echo "verify-linux-package: expected exactly one deb, found ${#debs[@]}" >&2; exit 1; }
[[ ${#rpms[@]} -eq 1 ]] || { echo "verify-linux-package: expected exactly one rpm, found ${#rpms[@]}" >&2; exit 1; }

deb_root="$(mktemp -d "${TMPDIR:-/tmp}/dsx-deb.XXXXXX")"
rpm_root="$(mktemp -d "${TMPDIR:-/tmp}/dsx-rpm.XXXXXX")"
ui_log="$(mktemp "${TMPDIR:-/tmp}/dsx-ui.XXXXXX.log")"
deb_install_attempted=0
rpm_install_attempted=0
cleanup() {
  local original_status=$?
  local cleanup_status=0
  trap - EXIT INT TERM
  set +e
  if [[ "$deb_install_attempted" == "1" ]]; then
    if ! timeout 60s sudo -n dpkg --purge "$expected_package" >/dev/null 2>&1; then
      echo "verify-linux-package: emergency dpkg purge failed for $expected_package" >&2
      cleanup_status=1
    fi
  fi
  if [[ "$rpm_install_attempted" == "1" ]]; then
    if ! timeout 60s sudo -n rpm --erase --nodeps "$expected_package" >/dev/null 2>&1; then
      echo "verify-linux-package: emergency rpm erase failed for $expected_package" >&2
      cleanup_status=1
    fi
  fi
  if ! rm -rf -- "$deb_root" "$rpm_root"; then
    echo "verify-linux-package: temporary package-tree cleanup failed" >&2
    cleanup_status=1
  fi
  if ! rm -f -- "$ui_log"; then
    echo "verify-linux-package: temporary UI-log cleanup failed" >&2
    cleanup_status=1
  fi
  if (( original_status != 0 )); then
    exit "$original_status"
  fi
  exit "$cleanup_status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

deb="${debs[0]}"
rpm_file="${rpms[0]}"

[[ "$(dpkg-deb -f "$deb" Package)" == "$expected_package" ]] || {
  echo "verify-linux-package: Debian package identity is not $expected_package" >&2
  exit 1
}
deb_version="$(dpkg-deb -f "$deb" Version)"
[[ "$deb_version" == "$expected_version-$expected_release" ]] || {
  echo "verify-linux-package: Debian identity is $deb_version, expected $expected_version-$expected_release" >&2
  exit 1
}
dpkg-deb --info "$deb" >/dev/null
dpkg-deb --contents "$deb" >/dev/null
dpkg-deb --extract "$deb" "$deb_root"

rpm -K "$rpm_file" >/dev/null
rpm_name="$(rpm -qp --queryformat '%{NAME}' "$rpm_file")"
[[ "$rpm_name" == "$expected_package" ]] || {
  echo "verify-linux-package: RPM package identity is not $expected_package" >&2
  exit 1
}
rpm_version="$(rpm -qp --queryformat '%{VERSION}' "$rpm_file")"
rpm_release="$(rpm -qp --queryformat '%{RELEASE}' "$rpm_file")"
[[ "$rpm_version" == "$expected_version" && "$rpm_release" == "$expected_release" ]] || {
  echo "verify-linux-package: RPM identity is $rpm_version-$rpm_release, expected $expected_version-$expected_release" >&2
  exit 1
}
(
  cd "$rpm_root"
  rpm2cpio "$rpm_file" | cpio -idm --quiet --no-absolute-filenames
)

find_launcher() {
  local root="$1"
  local label="$2"
  local candidate
  local -a candidates=()
  while IFS= read -r -d '' candidate; do
    candidates+=("$candidate")
  done < <(find "$root" -type f -perm -u+x -path '*/bin/*' -name "$expected_title" -print0)
  if [[ ${#candidates[@]} -ne 1 ]]; then
    echo "verify-linux-package: expected exactly one $label $expected_title launcher, found ${#candidates[@]}" >&2
    return 1
  fi
  [[ "$(basename "$(dirname "${candidates[0]}")")" == "bin" ]] || {
    echo "verify-linux-package: $label launcher is not the canonical app/bin/$expected_title path" >&2
    return 1
  }
  printf '%s\n' "${candidates[0]}"
}

verify_tree() {
  local root="$1"
  local launcher="$2"
  local require_desktop_entry="$3"
  python3 - "$root" "$launcher" "$require_desktop_entry" "$expected_title" "$repository_dir" \
    "$expected_entry" "$expected_assets" "$expected_app_id" "$expected_version" "$expected_build" <<'PY'
import collections
import hashlib
import json
import os
import pathlib
import re
import shlex
import stat
import struct
import sys
import zipfile

root = pathlib.Path(sys.argv[1]).resolve(strict=True)
launcher_argument = pathlib.Path(sys.argv[2])
require_desktop_entry = sys.argv[3] == "1"
expected_title = sys.argv[4]
repository = pathlib.Path(sys.argv[5]).resolve(strict=True)
entry_argument = sys.argv[6]
assets_argument = sys.argv[7]
expected_app_id = sys.argv[8]
expected_version = sys.argv[9]
expected_build = sys.argv[10]

if launcher_argument.is_symlink():
    raise SystemExit(f"launcher must not be a symbolic link: {launcher_argument}")
launcher = launcher_argument.resolve(strict=True)
try:
    launcher.relative_to(root)
except ValueError:
    raise SystemExit(f"launcher escapes the verified package tree: {launcher}")
launcher_mode = launcher.lstat().st_mode
if not stat.S_ISREG(launcher_mode) or not launcher_mode & stat.S_IXUSR:
    raise SystemExit(f"launcher is not an executable regular file: {launcher}")
if launcher.name != expected_title or launcher.parent.name != "bin":
    raise SystemExit(f"launcher is not the canonical app/bin/{expected_title} path: {launcher}")
app_root = launcher.parent.parent
try:
    app_root.relative_to(root)
except ValueError:
    raise SystemExit(f"application root escapes the verified package tree: {app_root}")
canonical_configuration = app_root / "lib" / "app" / f"{expected_title}.cfg"

# A jpackage application image may carry native helpers elsewhere, but app/bin is
# the launcher namespace. A second executable there is an independently invokable
# entry point and must never hide behind the expected title launcher.
bin_executables = []
for current, dirs, files in os.walk(launcher.parent, followlinks=False):
    for name in dirs + files:
        candidate = pathlib.Path(current, name)
        mode = candidate.lstat().st_mode
        executable = bool(mode & (stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH))
        if candidate.is_symlink():
            executable = executable or os.access(candidate, os.X_OK)
        if executable and not stat.S_ISDIR(mode):
            bin_executables.append(candidate)
if bin_executables != [launcher]:
    relative_executables = sorted(path.relative_to(app_root).as_posix()
                                  for path in bin_executables)
    raise SystemExit(
        f"app/bin must contain only the canonical executable launcher: {relative_executables!r}"
    )

def sha256_file(path):
    value = hashlib.sha256()
    with path.open("rb") as stream:
        while True:
            chunk = stream.read(64 * 1024)
            if not chunk:
                return value.hexdigest()
            value.update(chunk)

def inventory_digest(records):
    payload = json.dumps(records, ensure_ascii=True, separators=(",", ":"), sort_keys=True)
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()

def validate_elf_header(header, relative):
    if not header.startswith(b"\x7fELF"):
        return False
    if len(header) < 20:
        raise SystemExit(f"truncated ELF header: {relative}")
    if header[4] != 2 or header[5] != 1 or header[6] != 1:
        raise SystemExit(f"ELF must be 64-bit little-endian version 1: {relative}")
    e_machine = struct.unpack_from("<H", header, 18)[0]
    if e_machine != 62:
        raise SystemExit(f"ELF e_machine must be x86_64 (62), got {e_machine}: {relative}")
    return True

def inspect_elf(path, relative):
    with path.open("rb") as stream:
        header = stream.read(20)
    if not validate_elf_header(header, relative):
        return None
    return {"path": relative, "sha256": sha256_file(path)}

def digest_elf_stream(stream, header):
    value = hashlib.sha256()
    value.update(header)
    while True:
        chunk = stream.read(64 * 1024)
        if not chunk:
            return value.hexdigest()
        value.update(chunk)

regular = 0
package_files = []
package_elf = []
app_elf = []
for current, dirs, files in os.walk(root, followlinks=False):
    for name in dirs + files:
        path = pathlib.Path(current, name)
        mode = path.lstat().st_mode
        if mode & (stat.S_ISUID | stat.S_ISGID | stat.S_IWOTH):
            raise SystemExit(f"unsafe package mode {oct(mode)}: {path.relative_to(root)}")
        if path.is_symlink():
            resolved = path.resolve(strict=False)
            try:
                resolved.relative_to(root)
            except ValueError:
                raise SystemExit(f"escaping package symlink: {path.relative_to(root)} -> {os.readlink(path)}")
        elif stat.S_ISREG(mode):
            regular += 1
            package_files.append(path)
            relative = path.relative_to(root).as_posix()
            elf = inspect_elf(path, relative)
            if elf is not None:
                package_elf.append(elf)
                try:
                    app_relative = path.relative_to(app_root).as_posix()
                except ValueError:
                    pass
                else:
                    app_elf.append({"path": app_relative, "sha256": elf["sha256"]})
        elif not stat.S_ISDIR(mode):
            raise SystemExit(f"unsupported package entry type: {path.relative_to(root)}")

# JNI/media/package natives commonly live inside classpath JARs until runtime
# extraction. Treat those as shipped ELF payloads too; a package-level architecture
# field cannot prove a delayed native resource is x86_64.
package_elf_paths = {record["path"] for record in package_elf}
app_elf_paths = {record["path"] for record in app_elf}
for archive_path in (path for path in package_files if path.suffix.lower() == ".jar"):
    archive_relative = archive_path.relative_to(root).as_posix()
    try:
        app_archive_relative = archive_path.relative_to(app_root).as_posix()
    except ValueError:
        app_archive_relative = None
    try:
        archive = zipfile.ZipFile(archive_path)
    except zipfile.BadZipFile:
        continue
    with archive:
        for info in archive.infolist():
            if info.is_dir():
                continue
            package_relative = f"{archive_relative}!/{info.filename}"
            with archive.open(info) as stream:
                header = stream.read(20)
                if not validate_elf_header(header, package_relative):
                    continue
                if info.file_size > 512 * 1024 * 1024:
                    raise SystemExit(f"embedded ELF exceeds 512 MiB: {package_relative}")
                record = {"path": package_relative, "sha256": digest_elf_stream(stream, header)}
            if package_relative in package_elf_paths:
                raise SystemExit(f"duplicate packaged ELF path: {package_relative}")
            package_elf_paths.add(package_relative)
            package_elf.append(record)
            if app_archive_relative is not None:
                app_relative = f"{app_archive_relative}!/{info.filename}"
                if app_relative in app_elf_paths:
                    raise SystemExit(f"duplicate application ELF path: {app_relative}")
                app_elf_paths.add(app_relative)
                app_elf.append({"path": app_relative, "sha256": record["sha256"]})
if regular < 10:
    raise SystemExit("package tree is unexpectedly small")
if not package_elf or not app_elf:
    raise SystemExit("package does not contain an x86_64 native application payload")
if not any(record["path"] == launcher.relative_to(root).as_posix() for record in package_elf):
    raise SystemExit("canonical launcher is not an x86_64 ELF")

runtime_root = app_root / "lib" / "runtime"
if runtime_root.is_symlink() or not runtime_root.is_dir():
    raise SystemExit("package does not contain its canonical pinned JVM runtime")
# Compose Desktop pins its JVM by embedding a jlink runtime image built with
# --strip-native-commands, so the CLI launchers (bin/java, bin/keytool, ...) are
# intentionally absent: the native app launcher loads the runtime in process
# through libjli, never a bin/java subprocess. Prove the complete, pinned runtime
# by the load-bearing image it always ships instead of a stripped launcher.
runtime_release = runtime_root / "release"
runtime_modules = runtime_root / "lib" / "modules"
runtime_libjvm = runtime_root / "lib" / "server" / "libjvm.so"
for runtime_member in (runtime_release, runtime_modules, runtime_libjvm):
    if runtime_member.is_symlink() or not runtime_member.is_file():
        raise SystemExit("package does not contain its canonical pinned JVM runtime")
if b"JAVA_VERSION=" not in runtime_release.read_bytes():
    raise SystemExit("bundled JVM runtime does not declare its pinned JAVA_VERSION")
if not any(record["path"] == runtime_libjvm.relative_to(root).as_posix()
           for record in package_elf):
    raise SystemExit("bundled JVM runtime libjvm.so is not an x86_64 ELF")

# Only the launcher configuration under lib/app is policed here. The embedded JVM
# runtime legitimately ships its own JDK-owned configuration (lib/runtime/lib/jvm.cfg);
# the runtime image was verified above, so its internal files are not launcher
# configurations and must not be counted as a second, rogue one.
def _within_runtime(candidate):
    try:
        candidate.relative_to(runtime_root)
    except ValueError:
        return False
    return True
configuration_paths = sorted(
    path for path in package_files
    if path.suffix.lower() == ".cfg" and not _within_runtime(path)
)
if configuration_paths != [canonical_configuration]:
    relative_configs = [path.relative_to(root).as_posix() for path in configuration_paths]
    raise SystemExit(
        f"package must contain only the canonical launcher configuration {canonical_configuration.relative_to(root)}; "
        f"found {relative_configs!r}"
    )
if canonical_configuration.is_symlink() or not canonical_configuration.is_file():
    raise SystemExit("canonical launcher configuration is missing or unsafe")
if canonical_configuration.stat().st_size > 1024 * 1024:
    raise SystemExit("canonical launcher configuration exceeds 1 MiB")

if require_desktop_entry:
    desktop_paths = sorted(path for path in package_files if path.suffix.lower() == ".desktop")
    if len(desktop_paths) != 1:
        raise SystemExit(f"package must contain exactly one desktop entry, found {len(desktop_paths)}")
    values = {}
    for line in desktop_paths[0].read_text("utf-8", errors="strict").splitlines():
        if not line or line.startswith("#") or (line.startswith("[") and line.endswith("]")):
            continue
        if "=" not in line:
            raise SystemExit(f"invalid desktop-entry line: {line!r}")
        key, value = line.split("=", 1)
        if key in values:
            raise SystemExit(f"duplicate desktop-entry key: {key}")
        values[key] = value
    try:
        command = shlex.split(values.get("Exec", ""), posix=True)
    except ValueError as error:
        raise SystemExit(f"invalid desktop-entry Exec command: {error}")
    installed_launcher = "/" + launcher.relative_to(root).as_posix()
    if values.get("Name") != expected_title or values.get("Type") != "Application" or command != [installed_launcher]:
        raise SystemExit(
            f"desktop entry is not bound to the canonical launcher: Name={values.get('Name')!r} Exec={command!r}"
        )

def parse_configuration(path):
    entries = []
    section = None
    sections = set()
    text = path.read_text("utf-8", errors="strict")
    if "\x00" in text:
        raise SystemExit("launcher configuration contains NUL")
    for number, line in enumerate(text.splitlines(), 1):
        if not line or line.startswith("#") or line.startswith(";"):
            continue
        if line.startswith("[") and line.endswith("]"):
            section = line[1:-1]
            if not section or section in sections:
                raise SystemExit(f"invalid or duplicate launcher configuration section at line {number}")
            sections.add(section)
            continue
        if section is None or line.count("=") < 1:
            raise SystemExit(f"invalid launcher configuration line {number}")
        key, value = line.split("=", 1)
        if not key or key != key.strip() or value != value.strip():
            raise SystemExit(f"non-canonical launcher configuration line {number}")
        entries.append((section, key, value))
    return entries

configuration_entries = parse_configuration(canonical_configuration)

def configuration_values(section, key):
    return [value for candidate_section, candidate_key, value in configuration_entries
            if candidate_section == section and candidate_key == key]

if configuration_values("Application", "app.mainclass") != ["despia.engine.desktop.DesktopHostKt"]:
    raise SystemExit("launcher configuration has the wrong or duplicate main class")
for forbidden_key in ("app.mainjar", "app.mainmodule", "app.modulepath"):
    if configuration_values("Application", forbidden_key):
        raise SystemExit(f"launcher configuration contains forbidden startup key: {forbidden_key}")

classpath_values = configuration_values("Application", "app.classpath")
if not classpath_values:
    raise SystemExit("launcher configuration has no app.classpath")
classpath_archives = []
for classpath_value in classpath_values:
    token = classpath_value
    if not token.startswith("$APPDIR/"):
        raise SystemExit(f"classpath entry is not rooted at $APPDIR: {token!r}")
    relative = token[len("$APPDIR/"):]
    parts = pathlib.PurePosixPath(relative).parts
    if (not relative or "\\" in relative or "\x00" in relative or
            os.pathsep in relative or ";" in relative or
            pathlib.PurePosixPath(relative).as_posix() != relative or len(parts) != 1 or
            any(part in ("", ".", "..") for part in parts) or
            "*" in relative or not relative.endswith(".jar")):
        raise SystemExit(f"unsafe or non-canonical classpath entry: {token!r}")
    archive = canonical_configuration.parent / relative
    if archive.is_symlink() or not archive.is_file():
        raise SystemExit(f"classpath archive is missing or unsafe: {archive}")
    resolved = archive.resolve(strict=True)
    try:
        resolved.relative_to(canonical_configuration.parent.resolve(strict=True))
    except ValueError:
        raise SystemExit(f"classpath archive escapes $APPDIR: {archive}")
    if resolved in classpath_archives:
        raise SystemExit(f"duplicate launcher classpath archive: {archive.name}")
    classpath_archives.append(resolved)

java_options = configuration_values("JavaOptions", "java-options")

def is_effective_classpath_override(value):
    try:
        tokens = shlex.split(value, posix=True)
    except ValueError as error:
        raise SystemExit(f"invalid launcher JVM option quoting: {value!r}: {error}")
    for token in tokens:
        if re.match(r"^(?:-cp|-classpath|--class-path)(?:$|[=\s])", token):
            return True
        if token == "-Djava.class.path" or token.startswith("-Djava.class.path="):
            return True
        if token.startswith("-Xbootclasspath"):
            return True
    return False

classpath_overrides = [value for value in java_options if is_effective_classpath_override(value)]
if classpath_overrides:
    raise SystemExit(
        f"launcher JavaOptions may not override the verified classpath: {classpath_overrides!r}"
    )

# Compose Desktop 1.10.3 is pinned for this lane. Its generated native launcher
# has a closed option contract: jpackage version, Compose resources root, Compose
# Swing initialization, immutable DSX identity, optional build-owned entry, and
# Skiko's adjacent native library root. Treat every additional, missing, or
# duplicate record as startup injection rather than maintaining an incomplete
# JVM-option denylist.
expected_java_options = [
    f"-Djpackage.app-version={expected_version}",
    "-Dcompose.application.resources.dir=$APPDIR/resources",
    "-Dcompose.application.configure.swing.globals=true",
    f"-Ddsx.app.id={expected_app_id}",
    f"-Ddsx.app.title={expected_title}",
    f"-Ddsx.app.version={expected_version}",
    f"-Ddsx.app.build={expected_build}",
    "-Ddsx.app.identity.locked=true",
    "-Dskiko.library.path=$APPDIR",
]
if entry_argument:
    expected_java_options.append("-Ddsx.app.entry.resource=/dsx/AppEntry.dsx")
if collections.Counter(java_options) != collections.Counter(expected_java_options):
    raise SystemExit(
        f"launcher JavaOptions do not exactly match the pinned Compose/jpackage contract: "
        f"{java_options!r}"
    )

def repository_path(raw, kind):
    candidate = (repository / raw).resolve(strict=True)
    try:
        candidate.relative_to(repository)
    except ValueError:
        raise SystemExit(f"expected {kind} escapes the repository: {raw!r}")
    return candidate

def digest(reader):
    value = hashlib.sha256()
    while True:
        chunk = reader.read(64 * 1024)
        if not chunk:
            return value.hexdigest()
        value.update(chunk)

identity_items = [
    ("dsx.identity.schema", "dev.dsx.desktop-app-identity/v1"),
    ("dsx.app.id", expected_app_id),
    ("dsx.app.title", expected_title),
    ("dsx.app.version", expected_version),
    ("dsx.app.build", expected_build),
    ("dsx.app.identity.locked", "true"),
    ("dsx.app.entry.resource", "/dsx/AppEntry.dsx" if entry_argument else ""),
    ("dsx.app.assets.prefix", "/dsx/app-assets" if assets_argument else ""),
]
expected_identity = "".join(f"{key}={value}\n" for key, value in identity_items).encode("utf-8")
expected_resources = {
    "dsx/AppIdentity.properties": {
        "bytes": len(expected_identity),
        "sha256": hashlib.sha256(expected_identity).hexdigest(),
    }
}
if entry_argument:
    entry = repository_path(entry_argument, "entry")
    if entry.is_symlink() or not entry.is_file():
        raise SystemExit(f"expected entry is missing or unsafe: {entry_argument!r}")
    with entry.open("rb") as stream:
        expected_resources["dsx/AppEntry.dsx"] = {
            "bytes": entry.stat().st_size,
            "sha256": digest(stream),
        }
if assets_argument:
    assets = repository_path(assets_argument, "assets")
    if assets.is_symlink() or not assets.is_dir():
        raise SystemExit(f"expected assets path is not a directory: {assets_argument!r}")
    for current, dirs, files in os.walk(assets, followlinks=False):
        for name in dirs + files:
            asset = pathlib.Path(current, name)
            mode = asset.lstat().st_mode
            if asset.is_symlink() or not (stat.S_ISDIR(mode) or stat.S_ISREG(mode)):
                raise SystemExit(f"expected assets contain a link or unsupported file: {asset}")
            if stat.S_ISREG(mode):
                relative = asset.relative_to(assets).as_posix()
                with asset.open("rb") as stream:
                    expected_resources[f"dsx/app-assets/{relative}"] = {
                        "bytes": asset.stat().st_size,
                        "sha256": digest(stream),
                    }

packaged_resources = {}
identity_bytes = None
desktop_host_class = "despia/engine/desktop/DesktopHostKt.class"
desktop_host_origins = []
desktop_host_shadows = []
versioned_desktop_host = re.compile(
    rf"META-INF/versions/[1-9][0-9]*/{re.escape(desktop_host_class)}"
)
is_protected_name = lambda name: (
    name == "dsx/AppIdentity.properties" or
    name == "dsx/AppEntry.dsx" or
    name.startswith("dsx/app-assets/")
)
for archive_path in classpath_archives:
    try:
        archive = zipfile.ZipFile(archive_path)
    except zipfile.BadZipFile as error:
        raise SystemExit(f"launcher classpath contains an invalid JAR {archive_path.name}: {error}")
    with archive:
        manifests = [info for info in archive.infolist()
                     if info.filename == "META-INF/MANIFEST.MF" and not info.is_dir()]
        if len(manifests) > 1:
            raise SystemExit(f"launcher classpath JAR has duplicate manifests: {archive_path.name}")
        if manifests:
            if manifests[0].file_size > 1024 * 1024:
                raise SystemExit(f"launcher classpath JAR manifest exceeds 1 MiB: {archive_path.name}")
            with archive.open(manifests[0]) as manifest_stream:
                manifest = manifest_stream.read(1024 * 1024 + 1)
            if len(manifest) > 1024 * 1024 or b"\x00" in manifest:
                raise SystemExit(f"launcher classpath JAR manifest is unsafe: {archive_path.name}")
            if re.search(br"(?im)^Class-Path[ \t]*:", manifest):
                raise SystemExit(
                    f"launcher classpath JAR may not extend the verified classpath through its manifest: "
                    f"{archive_path.name}"
                )
        for info in archive.infolist():
            name = info.filename
            if name == desktop_host_class and not info.is_dir():
                desktop_host_origins.append(f"{archive_path.name}!/{name}")
            elif versioned_desktop_host.fullmatch(name) and not info.is_dir():
                desktop_host_shadows.append(f"{archive_path.name}!/{name}")
            if not is_protected_name(name) or info.is_dir():
                continue
            if name in packaged_resources:
                raise SystemExit(f"duplicate packaged application resource: {name}")
            expected = expected_resources.get(name)
            if expected is None:
                raise SystemExit(f"unexpected packaged application resource: {name}")
            if info.file_size != expected["bytes"]:
                raise SystemExit(
                    f"packaged application resource size mismatch: {name} "
                    f"({info.file_size} != {expected['bytes']})"
                )
            with archive.open(info) as stream:
                if name == "dsx/AppIdentity.properties":
                    identity_bytes = stream.read(expected["bytes"] + 1)
                    actual_digest = hashlib.sha256(identity_bytes).hexdigest()
                else:
                    actual_digest = digest(stream)
            packaged_resources[name] = {"bytes": info.file_size, "sha256": actual_digest}
            if name == "dsx/AppIdentity.properties":
                if len(identity_bytes) != expected["bytes"]:
                    raise SystemExit("dsx/AppIdentity.properties expanded beyond its declared size")

if len(desktop_host_origins) != 1 or desktop_host_shadows:
    found_desktop_hosts = desktop_host_origins + desktop_host_shadows
    raise SystemExit(
        f"launcher classpath must contain exactly one {desktop_host_class}; "
        f"found {found_desktop_hosts!r}"
    )

classpath_set = set(classpath_archives)
for archive_path in (path for path in package_files if path.suffix.lower() == ".jar"):
    resolved = archive_path.resolve(strict=True)
    if resolved in classpath_set:
        continue
    try:
        archive = zipfile.ZipFile(archive_path)
    except zipfile.BadZipFile:
        continue
    with archive:
        decoys = [info.filename for info in archive.infolist()
                  if is_protected_name(info.filename) and not info.is_dir()]
    if decoys:
        raise SystemExit(
            f"protected application resources exist outside the launcher's classpath in {archive_path}: {decoys!r}"
        )

if packaged_resources.keys() != expected_resources.keys():
    missing = sorted(expected_resources.keys() - packaged_resources.keys())
    unexpected = sorted(packaged_resources.keys() - expected_resources.keys())
    raise SystemExit(f"packaged application resource inventory mismatch: missing={missing!r} unexpected={unexpected!r}")
for name, expected_record in expected_resources.items():
    if packaged_resources[name] != expected_record:
        raise SystemExit(f"packaged application resource digest mismatch: {name}")
if identity_bytes != expected_identity:
    raise SystemExit("dsx/AppIdentity.properties is not the exact ordered eight-key LF-only identity record")

truth = {
    "schema": "dev.dsx.linux-payload-truth/v1",
    "configurationSha256": sha256_file(canonical_configuration),
    "identitySha256": hashlib.sha256(expected_identity).hexdigest(),
    "resourceInventorySha256": inventory_digest(packaged_resources),
    "appElfCount": len(app_elf),
    "appElfInventorySha256": inventory_digest(sorted(app_elf, key=lambda record: record["path"])),
    "packageElfCount": len(package_elf),
    "packageElfInventorySha256": inventory_digest(sorted(package_elf, key=lambda record: record["path"])),
}
print(json.dumps(truth, sort_keys=True, separators=(",", ":")))
PY
}

deb_launcher="$(find_launcher "$deb_root" "extracted Debian")"
rpm_launcher="$(find_launcher "$rpm_root" "extracted RPM")"
deb_truth="$(verify_tree "$deb_root" "$deb_launcher" 1)"
rpm_truth="$(verify_tree "$rpm_root" "$rpm_launcher" 1)"
python3 - "$deb_truth" "$rpm_truth" <<'PY'
import json
import sys

deb = json.loads(sys.argv[1])
rpm = json.loads(sys.argv[2])
# jpackage emits byte-different launcher .cfg files for its separate deb and rpm runs
# of the same payload: beyond line order it assigns different disambiguating hashes to
# the app.classpath jar file names, even though every jar's CONTENT is identical, so
# configurationSha256 legitimately differs across the two packages. The launcher
# contract is pinned per package by verify_tree (exact java-options multiset, main
# class, fully validated classpath) and the shared payload is proven by the identity,
# resource and ELF inventories; compare those and exclude the incidental cfg byte hash.
# (configurationSha256 is still cross-checked installed-vs-extracted, where the same
# package guarantees identical .cfg bytes and so proves install fidelity.)
def payload_fields(truth):
    return {key: value for key, value in truth.items() if key != "configurationSha256"}
if payload_fields(deb) != payload_fields(rpm):
    raise SystemExit(f"deb/rpm payload truth mismatch: deb={deb!r} rpm={rpm!r}")
PY

verify_installed_runtime() {
  local launcher="$1"
  local report="$2"
  local output
  # Capture the self-test's own output. On success it prints a single
  # DSX_DESKTOP_SELF_TEST line we discard; on failure that line carries the error
  # code (a failed check id or exception), so surface it here instead of letting
  # set -e abort the step with no diagnostic at all.
  if ! output="$(timeout 30s "$launcher" --dsx-self-test --dsx-self-test-output "$report" 2>&1)"; then
    echo "verify-linux-package: packaged self-test failed for $launcher" >&2
    printf '%s\n' "$output" >&2
    exit 1
  fi
  python3 - "$report" <<'PY'
import json
import pathlib
import sys

path = pathlib.Path(sys.argv[1])
data = json.loads(path.read_text("utf-8"))
expected = {
    "schema": "dev.dsx.desktop-self-test/v1",
    "status": "ok",
    "os": "linux",
    "desktop": True,
    "native": True,
    "renderer": "compose",
}
if data != expected:
    raise SystemExit(f"installed self-test mismatch: {data!r}")
PY
}

verify_installed_runtime "$deb_launcher" "$deb_root/self-test.json"
verify_installed_runtime "$rpm_launcher" "$rpm_root/self-test.json"

# Extraction proves payload structure; only a real dpkg lifecycle executes package
# maintainer scripts and desktop integration. This gate is restricted to an explicitly
# opted-in ephemeral CI runner and refuses to replace an existing system package.
sudo -n true
if dpkg-query -W -f='${db:Status-Status}' "$expected_package" >/dev/null 2>&1; then
  echo "verify-linux-package: refusing to replace pre-existing system package $expected_package" >&2
  exit 1
fi
if rpm -q "$expected_package" >/dev/null 2>&1; then
  echo "verify-linux-package: refusing to overwrite files owned by pre-existing RPM package $expected_package" >&2
  exit 1
fi
deb_install_attempted=1
timeout 60s sudo -n dpkg --install "$deb"
[[ "$(dpkg-query -W -f='${db:Status-Status}' "$expected_package")" == "installed" ]] || {
  echo "verify-linux-package: dpkg did not report $expected_package as installed" >&2
  exit 1
}
dpkg --verify "$expected_package"
installed_candidates=()
while IFS= read -r candidate; do
  if [[ "$(basename "$candidate")" == "$expected_title" &&
        "$(basename "$(dirname "$candidate")")" == "bin" &&
        -f "$candidate" && ! -L "$candidate" && -x "$candidate" ]]; then
    installed_candidates+=("$candidate")
  fi
done < <(dpkg-query -L "$expected_package" | sort)
[[ ${#installed_candidates[@]} -eq 1 ]] || {
  echo "verify-linux-package: expected exactly one system-installed $expected_title launcher, found ${#installed_candidates[@]}" >&2
  exit 1
}
installed_launcher="${installed_candidates[0]}"
installed_app_root="$(cd "$(dirname "$installed_launcher")/.." && pwd -P)"
installed_truth="$(verify_tree "$installed_app_root" "$installed_launcher" 0)"

inventory_installed_package_elf() {
  local package_manager="$1"
  python3 - "$expected_package" "$package_manager" <<'PY'
import hashlib
import json
import os
import pathlib
import stat
import struct
import subprocess
import sys
import zipfile

package = sys.argv[1]
manager = sys.argv[2]
commands = {
    "dpkg": ["dpkg-query", "-L", package],
    # rpm queries run through sudo so they read the same root-owned database the
    # sudo rpm --install wrote (Debian's rpm otherwise reports the package absent).
    "rpm": ["sudo", "-n", "rpm", "-ql", package],
}
if manager not in commands:
    raise SystemExit(f"unsupported installed package manager: {manager}")
listing = subprocess.run(
    commands[manager],
    check=True,
    stdout=subprocess.PIPE,
    stderr=subprocess.PIPE,
    text=True,
    encoding="utf-8",
).stdout.splitlines()
if not listing:
    raise SystemExit(f"installed package has an empty file list: {package}")

def sha256_file(path):
    value = hashlib.sha256()
    with path.open("rb") as stream:
        while True:
            chunk = stream.read(64 * 1024)
            if not chunk:
                return value.hexdigest()
            value.update(chunk)

def validate_elf_header(header, label):
    if not header.startswith(b"\x7fELF"):
        return False
    if len(header) < 20 or header[4] != 2 or header[5] != 1 or header[6] != 1:
        raise SystemExit(f"installed ELF must be 64-bit little-endian version 1: {label}")
    e_machine = struct.unpack_from("<H", header, 18)[0]
    if e_machine != 62:
        raise SystemExit(f"installed ELF e_machine must be x86_64 (62), got {e_machine}: {label}")
    return True

def digest_elf_stream(stream, header):
    value = hashlib.sha256()
    value.update(header)
    while True:
        chunk = stream.read(64 * 1024)
        if not chunk:
            return value.hexdigest()
        value.update(chunk)

records = []
seen = set()
record_paths = set()
for raw in listing:
    if not raw.startswith("/") or "\x00" in raw:
        raise SystemExit(f"unsafe installed package path: {raw!r}")
    normalized = os.path.normpath(raw)
    if normalized in seen:
        raise SystemExit(f"duplicate installed package path: {raw!r}")
    seen.add(normalized)
    path = pathlib.Path(normalized)
    try:
        mode = path.lstat().st_mode
    except FileNotFoundError:
        raise SystemExit(f"installed package path is missing: {raw}")
    if stat.S_ISLNK(mode) or stat.S_ISDIR(mode):
        continue
    if not stat.S_ISREG(mode):
        raise SystemExit(f"installed package contains an unsupported file type: {raw}")
    with path.open("rb") as stream:
        header = stream.read(20)
    installed_relative = path.relative_to("/").as_posix()
    if validate_elf_header(header, installed_relative):
        record_paths.add(installed_relative)
        records.append({"path": installed_relative, "sha256": sha256_file(path)})

    if path.suffix.lower() != ".jar":
        continue
    try:
        archive = zipfile.ZipFile(path)
    except zipfile.BadZipFile:
        continue
    with archive:
        for info in archive.infolist():
            if info.is_dir():
                continue
            label = f"{installed_relative}!/{info.filename}"
            with archive.open(info) as stream:
                embedded_header = stream.read(20)
                if not validate_elf_header(embedded_header, label):
                    continue
                if info.file_size > 512 * 1024 * 1024:
                    raise SystemExit(f"installed embedded ELF exceeds 512 MiB: {label}")
                digest = digest_elf_stream(stream, embedded_header)
            if label in record_paths:
                raise SystemExit(f"duplicate installed ELF path: {label}")
            record_paths.add(label)
            records.append({"path": label, "sha256": digest})
if not records:
    raise SystemExit("installed package contains no x86_64 ELF payload")
records.sort(key=lambda record: record["path"])
payload = json.dumps(records, ensure_ascii=True, separators=(",", ":"), sort_keys=True)
result = {
    "count": len(records),
    "inventorySha256": hashlib.sha256(payload.encode("utf-8")).hexdigest(),
}
print(json.dumps(result, sort_keys=True, separators=(",", ":")))
PY
}

installed_elf_truth="$(inventory_installed_package_elf dpkg)"
python3 - "$deb_truth" "$installed_truth" "$installed_elf_truth" <<'PY'
import json
import sys

extracted = json.loads(sys.argv[1])
installed = json.loads(sys.argv[2])
installed_elf = json.loads(sys.argv[3])
app_fields = (
    "schema",
    "configurationSha256",
    "identitySha256",
    "resourceInventorySha256",
    "appElfCount",
    "appElfInventorySha256",
)
for field in app_fields:
    if installed.get(field) != extracted.get(field):
        raise SystemExit(
            f"installed app artifact truth differs from extracted deb for {field}: "
            f"installed={installed.get(field)!r} extracted={extracted.get(field)!r}"
        )
if installed_elf.get("count") != extracted.get("packageElfCount"):
    raise SystemExit("installed package ELF count differs from the extracted deb")
if installed_elf.get("inventorySha256") != extracted.get("packageElfInventorySha256"):
    raise SystemExit("installed package ELF inventory differs from the extracted deb")
PY
verify_installed_runtime "$installed_launcher" "$report_dir/deb-installed-self-test.json"

# A real Compose window under a native Linux display server. This is intentionally
# separate from the display-free installed check: a broken Skiko/AWT bundle can pass
# kernel startup yet fail to create any window.
verify_installed_ui() {
  local launcher="$1"
  : > "$ui_log"
  xvfb-run -a -s '-screen 0 1440x900x24 -nolisten tcp' \
    bash -c 'set -euo pipefail
      launcher="$1"
      log="$2"
      title="$3"
      "$launcher" --dsx-ui-smoke >"$log" 2>&1 &
      child=$!
      trap '\''kill "$child" 2>/dev/null || true; wait "$child" 2>/dev/null || true'\'' EXIT
      for _ in $(seq 1 60); do
        if xwininfo -root -tree 2>/dev/null | grep -Fq "\"$title\""; then
          exit 0
        fi
        if ! kill -0 "$child" 2>/dev/null; then
          wait "$child" || true
          cat "$log" >&2
          exit 1
        fi
        sleep 0.5
      done
      cat "$log" >&2
      exit 1' _ "$launcher" "$ui_log" "$expected_title"
}

verify_installed_ui "$installed_launcher"

installed_launcher_snapshot="$installed_launcher"
timeout 60s sudo -n dpkg --purge "$expected_package"
if dpkg-query -W -f='${db:Status-Status}' "$expected_package" >/dev/null 2>&1; then
  echo "verify-linux-package: $expected_package still registered after purge" >&2
  exit 1
fi
deb_install_attempted=0
[[ ! -e "$installed_launcher_snapshot" ]] || {
  echo "verify-linux-package: installed launcher survived package purge" >&2
  exit 1
}

# Exercise the RPM package manager as well as the extracted payload. Running rpm
# on the same opted-in ephemeral Ubuntu worker executes the RPM scriptlets and
# database lifecycle; RPM-family distro/repository behavior remains a separate
# target-native promotion gate.
# Debian ships rpm without an initialized package database, so a bare `rpm --install`
# extracts the payload yet registers nothing, and every later `rpm -q`/`--verify`/`-ql`
# reports the package "not installed". Initialize the database first (a no-op when one
# already exists) so the install actually registers on this Debian-family worker.
sudo -n rpm --initdb
if sudo -n rpm -q "$expected_package" >/dev/null 2>&1; then
  echo "verify-linux-package: refusing to replace pre-existing RPM package $expected_package" >&2
  exit 1
fi
rpm_install_attempted=1
# rpm on this Debian-family worker is best-effort and has aborted this step with no
# diagnostic; capture each rpm command's own output so a scriptlet, database, or
# verify failure is visible instead of a silent set -e abort.
if ! rpm_install_output="$(timeout 60s sudo -n rpm --install --nodeps "$rpm_file" 2>&1)"; then
  echo "verify-linux-package: rpm --install failed for $rpm_file" >&2
  printf '%s\n' "$rpm_install_output" >&2
  exit 1
fi
[[ -z "$rpm_install_output" ]] || printf 'verify-linux-package: rpm --install: %s\n' "$rpm_install_output" >&2
if ! installed_rpm_identity="$(sudo -n rpm -q --queryformat '%{NAME} %{VERSION} %{RELEASE} %{ARCH}' "$expected_package" 2>&1)"; then
  echo "verify-linux-package: rpm -q failed after install: ${installed_rpm_identity}" >&2
  exit 1
fi
[[ "$installed_rpm_identity" == "$expected_package $expected_version $expected_release x86_64" ]] || {
  echo "verify-linux-package: installed RPM identity mismatch: $installed_rpm_identity" >&2
  exit 1
}
# --nodeps: the package was installed with --nodeps, and rpm's database on this
# Debian-family worker has no record of the dpkg-provided /bin/sh and xdg-utils, so a
# dependency verify always reports them "unsatisfied". Verify the package's FILES
# (size, digest, mode, mtime) without the meaningless cross-manager dependency check.
if ! rpm_verify_output="$(sudo -n rpm --verify --nodeps "$expected_package" 2>&1)"; then
  echo "verify-linux-package: rpm --verify reported a discrepancy for $expected_package" >&2
  printf '%s\n' "$rpm_verify_output" >&2
  exit 1
fi
rpm_installed_candidates=()
while IFS= read -r candidate; do
  if [[ "$(basename "$candidate")" == "$expected_title" &&
        "$(basename "$(dirname "$candidate")")" == "bin" &&
        -f "$candidate" && ! -L "$candidate" && -x "$candidate" ]]; then
    rpm_installed_candidates+=("$candidate")
  fi
done < <(sudo -n rpm -ql "$expected_package" | sort)
[[ ${#rpm_installed_candidates[@]} -eq 1 ]] || {
  echo "verify-linux-package: expected exactly one RPM-installed $expected_title launcher, found ${#rpm_installed_candidates[@]}" >&2
  exit 1
}
rpm_installed_launcher="${rpm_installed_candidates[0]}"
rpm_installed_app_root="$(cd "$(dirname "$rpm_installed_launcher")/.." && pwd -P)"
rpm_installed_truth="$(verify_tree "$rpm_installed_app_root" "$rpm_installed_launcher" 0)"
rpm_installed_elf_truth="$(inventory_installed_package_elf rpm)"
python3 - "$rpm_truth" "$rpm_installed_truth" "$rpm_installed_elf_truth" <<'PY'
import json
import sys

extracted = json.loads(sys.argv[1])
installed = json.loads(sys.argv[2])
installed_elf = json.loads(sys.argv[3])
app_fields = (
    "schema",
    "configurationSha256",
    "identitySha256",
    "resourceInventorySha256",
    "appElfCount",
    "appElfInventorySha256",
)
for field in app_fields:
    if installed.get(field) != extracted.get(field):
        raise SystemExit(
            f"installed app artifact truth differs from extracted rpm for {field}: "
            f"installed={installed.get(field)!r} extracted={extracted.get(field)!r}"
        )
if installed_elf.get("count") != extracted.get("packageElfCount"):
    raise SystemExit("installed package ELF count differs from the extracted rpm")
if installed_elf.get("inventorySha256") != extracted.get("packageElfInventorySha256"):
    raise SystemExit("installed package ELF inventory differs from the extracted rpm")
PY
verify_installed_runtime "$rpm_installed_launcher" "$report_dir/rpm-installed-self-test.json"
verify_installed_ui "$rpm_installed_launcher"

rpm_installed_launcher_snapshot="$rpm_installed_launcher"
timeout 60s sudo -n rpm --erase --nodeps "$expected_package"
if sudo -n rpm -q "$expected_package" >/dev/null 2>&1; then
  echo "verify-linux-package: $expected_package remains in the RPM database after erase" >&2
  exit 1
fi
rpm_install_attempted=0
[[ ! -e "$rpm_installed_launcher_snapshot" ]] || {
  echo "verify-linux-package: RPM-installed launcher survived package erase" >&2
  exit 1
}

{
  sha256sum "$deb"
  sha256sum "$rpm_file"
} > "$report_dir/linux-package-sha256.txt"

echo "verify-linux-package: $expected_package ($expected_title) deb/rpm metadata and trees plus real dpkg and rpm install/self-test/UI/removal lifecycles passed"
