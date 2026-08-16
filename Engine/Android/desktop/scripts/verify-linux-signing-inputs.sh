#!/usr/bin/env bash
# Bind the exact deb/rpm bytes to the checksum inventory produced by the package verifier.
set -euo pipefail

if [[ $# -ne 3 ]]; then
  echo "usage: $0 /path/to/linux-package-sha256.txt /path/to/app.deb /path/to/app.rpm" >&2
  exit 64
fi

inventory=$1
deb=$2
rpm=$3

for tool in cmp mktemp python3 sha256sum; do
  command -v "$tool" >/dev/null 2>&1 || {
    echo "verify-linux-signing-inputs: missing required tool: $tool" >&2
    exit 2
  }
done

[[ -f "$inventory" && ! -L "$inventory" && -s "$inventory" ]] || {
  echo "verify-linux-signing-inputs: verified checksum inventory is missing or unsafe" >&2
  exit 1
}
for artifact in "$deb" "$rpm"; do
  [[ -f "$artifact" && ! -L "$artifact" ]] || {
    echo "verify-linux-signing-inputs: package is missing or unsafe: $artifact" >&2
    exit 1
  }
done

safe_tmp_root="$(python3 - "${TMPDIR:-/tmp}" <<'PY'
import os
import pathlib
import stat
import sys

candidate = pathlib.Path(sys.argv[1])
try:
    info = candidate.lstat()
except OSError as error:
    raise SystemExit(f"temporary root is unavailable: {error}")
if not stat.S_ISDIR(info.st_mode) or stat.S_ISLNK(info.st_mode):
    raise SystemExit("temporary root must be a real directory")
resolved = candidate.resolve(strict=True)
if resolved == pathlib.Path("/"):
    raise SystemExit("temporary root must not be filesystem root")
mode = resolved.stat().st_mode
owner = resolved.stat().st_uid
if owner != os.getuid() and not (
    owner == 0 and mode & stat.S_ISVTX and mode & stat.S_IWOTH
):
    raise SystemExit("temporary root has unsafe ownership or mode")
print(resolved)
PY
)" || {
  echo "verify-linux-signing-inputs: temporary root validation failed" >&2
  exit 2
}
current="$(mktemp "$safe_tmp_root/dsx-linux-current-sha256.XXXXXXXX")"
[[ "$current" == "$safe_tmp_root"/* && -f "$current" && ! -L "$current" ]] || {
  echo "verify-linux-signing-inputs: temporary inventory creation escaped the safe root" >&2
  exit 2
}
cleanup() {
  local original_status=$?
  local cleanup_status=0
  trap - EXIT INT TERM
  set +e
  if ! rm -f -- "$current"; then
    echo "verify-linux-signing-inputs: temporary inventory cleanup failed" >&2
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

LC_ALL=C sha256sum -- "$deb" "$rpm" > "$current"
if ! cmp -s "$inventory" "$current"; then
  echo "verify-linux-signing-inputs: current deb/rpm bytes differ from the verified checksum inventory" >&2
  exit 1
fi

echo "verify-linux-signing-inputs: current deb/rpm bytes exactly match the verified inventory"
