#!/usr/bin/env bash
# Produce a fail-closed DSX Linux release using the repository-pinned OpenPGP
# trust anchor. This command is intentionally tag-lane-only: public PR jobs do
# not declare or execute it and cannot inherit its protected key variables.
set +x
set -euo pipefail

[[ "$(uname -s)" == "Linux" ]] || { echo "sign-linux-artifacts: native Linux is required" >&2; exit 2; }
umask 077
unset BASH_ENV ENV CDPATH GPG_AGENT_INFO GPG_TTY RUBYOPT PYTHONPATH PYTHONHOME \
  LD_PRELOAD LD_LIBRARY_PATH DYLD_INSERT_LIBRARIES DYLD_LIBRARY_PATH SSLKEYLOGFILE
export PATH=/usr/sbin:/usr/bin:/sbin:/bin

required_tools=(apt-ftparchive awk base64 basename chmod cmp createrepo_c dirname dpkg-deb env find gpg gpgconf gzip id install mkdir mktemp mv python3 readlink rm sha256sum sort stat)
for tool in "${required_tools[@]}"; do
  resolved="$(command -v -- "$tool" || true)"
  canonical="$(readlink -f -- "$resolved" 2>/dev/null || true)"
  [[ -n "$resolved" && -n "$canonical" && -f "$canonical" && -x "$canonical" ]] || {
    echo "sign-linux-artifacts: missing or unsafe tool: $tool" >&2
    exit 2
  }
done

private_key_b64="${DSX_LINUX_SIGNING_PRIVATE_KEY_B64:?protected signing key is required}"
expected_fingerprint="${DSX_LINUX_SIGNING_KEY_FINGERPRINT:?protected signing fingerprint is required}"
passphrase="${DSX_LINUX_SIGNING_PASSPHRASE:?protected signing passphrase is required}"
source_commit="${DSX_LINUX_SOURCE_COMMIT:?release source commit is required}"
source_tree="${DSX_LINUX_SOURCE_TREE:?release source tree is required}"
source_tag="${DSX_LINUX_SOURCE_TAG:?release source tag is required}"
build_id="${DSX_LINUX_BUILD_ID:?release build id is required}"
build_number="${DSX_LINUX_BUILD_NUMBER:?release build number is required}"
source_epoch="${DSX_LINUX_SOURCE_EPOCH:?release source epoch is required}"
source_admission="${DSX_LINUX_SOURCE_ADMISSION:?clean source-admission report is required}"
app_id="${DSX_DESKTOP_APP_ID:?desktop app ID is required}"
app_title="${DSX_DESKTOP_TITLE:?desktop title is required}"
app_version="${DSX_DESKTOP_VERSION:?desktop version is required}"
app_release="${DSX_DESKTOP_RELEASE:?desktop package release is required}"
app_build="${DSX_DESKTOP_BUILD:?desktop build identity is required}"
unset DSX_LINUX_SIGNING_PRIVATE_KEY_B64 DSX_LINUX_SIGNING_KEY_FINGERPRINT \
  DSX_LINUX_SIGNING_PASSPHRASE

expected_fingerprint="${expected_fingerprint//[[:space:]]/}"
expected_fingerprint="${expected_fingerprint^^}"
[[ "$expected_fingerprint" =~ ^[0-9A-F]{40}$ ]] || {
  echo "sign-linux-artifacts: fingerprint must be an exact 40-hex primary-key fingerprint" >&2
  exit 2
}
[[ "$source_commit" =~ ^[0-9a-f]{40,64}$ && "$source_tree" =~ ^[0-9a-f]{40,64}$ ]] || {
  echo "sign-linux-artifacts: source commit/tree must be full lowercase Git object IDs" >&2
  exit 2
}
[[ "$source_tag" =~ ^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]] || {
  echo "sign-linux-artifacts: source tag is not exact semver" >&2
  exit 2
}
[[ "$build_id" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$ &&
   "$build_number" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$ &&
   "$source_epoch" =~ ^[0-9]{9,12}$ ]] || {
  echo "sign-linux-artifacts: build provenance is malformed" >&2
  exit 2
}
[[ "$app_id" =~ ^[a-z0-9][a-z0-9.-]{1,127}$ &&
   "$app_version" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ &&
   "$app_release" =~ ^[1-9][0-9]*$ &&
   "$app_build" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$ ]] || {
  echo "sign-linux-artifacts: immutable app identity is malformed" >&2
  exit 2
}
(( ${#private_key_b64} <= 262144 )) || {
  echo "sign-linux-artifacts: encoded key is unexpectedly large" >&2
  exit 2
}
(( ${#passphrase} <= 1024 )) || {
  echo "sign-linux-artifacts: signing passphrase is unexpectedly large" >&2
  exit 2
}
[[ "$app_title" =~ ^[A-Za-z0-9]([A-Za-z0-9\ ._-]{0,62}[A-Za-z0-9._-])?$ ]] || {
  echo "sign-linux-artifacts: desktop title is not portable" >&2
  exit 2
}
[[ -f "$source_admission" && ! -L "$source_admission" && -s "$source_admission" ]] || {
  echo "sign-linux-artifacts: clean source-admission report is missing or unsafe" >&2
  exit 1
}
(( $(stat -c '%s' -- "$source_admission") <= 2097152 )) || {
  echo "sign-linux-artifacts: clean source-admission report is unexpectedly large" >&2
  exit 1
}

desktop_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
repo_root="$(cd "$desktop_dir/../../../.." && pwd -P)"
build_dir="$desktop_dir/build"
report_dir="$build_dir/reports"
repository="$build_dir/repository"
trust_key="$repo_root/ClosedSource/release/linux-signing-public-key.asc"
trust_policy="$repo_root/ClosedSource/release/linux-signing-trust.json"
release_verifier="$desktop_dir/scripts/verify-linux-release.py"
inventory_verifier="$desktop_dir/scripts/verify-linux-signing-inputs.sh"
for trusted_input in "$trust_key" "$trust_policy" "$release_verifier" "$inventory_verifier"; do
  [[ -f "$trusted_input" && ! -L "$trusted_input" ]] || {
    echo "sign-linux-artifacts: required tracked release input is missing or unsafe: $trusted_input" >&2
    exit 1
  }
done
[[ -x "$release_verifier" && -x "$inventory_verifier" ]] || {
  echo "sign-linux-artifacts: release verifiers must be executable" >&2
  exit 1
}

# Validate the committed trust descriptor with duplicate-key rejection before
# importing any private material. The protected fingerprint is only a second
# binding; it can never replace the Git-pinned public trust anchor.
trust_fingerprint="$({
  python3 - "$trust_policy" "$trust_key" <<'PY'
import hashlib
import json
import pathlib
import re
import sys

def pairs(items):
    out = {}
    for key, value in items:
        if key in out:
            raise SystemExit("duplicate trust-policy JSON key")
        out[key] = value
    return out

policy_path = pathlib.Path(sys.argv[1])
key_path = pathlib.Path(sys.argv[2])
policy = json.loads(policy_path.read_text(encoding="utf-8"), object_pairs_hook=pairs)
expected = {"schema", "status", "primaryFingerprint", "publicKey", "publicKeySha256", "validFrom", "validUntil"}
if set(policy) != expected or policy["schema"] != "dev.dsx.linux-signing-trust/v1" or policy["status"] != "active":
    raise SystemExit("Linux signing trust policy is not the exact active v1 schema")
fingerprint = policy["primaryFingerprint"]
if not isinstance(fingerprint, str) or not re.fullmatch(r"[0-9A-F]{40}", fingerprint):
    raise SystemExit("Linux signing trust fingerprint is invalid")
if policy["publicKey"] != "linux-signing-public-key.asc":
    raise SystemExit("Linux signing public-key path is not canonical")
key = key_path.read_bytes()
if b"PRIVATE KEY" in key or b"SECRET KEY" in key:
    raise SystemExit("Linux public trust anchor contains private-key material")
if hashlib.sha256(key).hexdigest() != policy["publicKeySha256"]:
    raise SystemExit("Linux public trust anchor digest mismatch")
print(fingerprint)
PY
} 2>&1)" || {
  echo "sign-linux-artifacts: pinned trust-policy validation failed: $trust_fingerprint" >&2
  exit 1
}
[[ "$trust_fingerprint" == "$expected_fingerprint" ]] || {
  echo "sign-linux-artifacts: protected fingerprint does not match the Git-pinned trust anchor" >&2
  exit 1
}

for directory in "$desktop_dir" "$build_dir"; do
  [[ -d "$directory" && ! -L "$directory" ]] || {
    echo "sign-linux-artifacts: build directory is missing or unsafe: $directory" >&2
    exit 1
  }
done
mkdir -p -- "$report_dir"
[[ -d "$report_dir" && ! -L "$report_dir" ]] || {
  echo "sign-linux-artifacts: report directory is unsafe" >&2
  exit 1
}
mapfile -t debs < <(find "$build_dir/compose/binaries/main/deb" -maxdepth 1 -type f -name '*.deb' -print | LC_ALL=C sort)
mapfile -t rpms < <(find "$build_dir/compose/binaries/main/rpm" -maxdepth 1 -type f -name '*.rpm' -print | LC_ALL=C sort)
[[ ${#debs[@]} -eq 1 && ${#rpms[@]} -eq 1 ]] || {
  echo "sign-linux-artifacts: exactly one deb and one rpm are required" >&2
  exit 1
}
deb="${debs[0]}"
rpm_file="${rpms[0]}"
inventory="$report_dir/linux-package-sha256.txt"
[[ -f "$inventory" && ! -L "$inventory" && -s "$inventory" ]] || {
  echo "sign-linux-artifacts: verified SHA-256 inventory is missing or unsafe" >&2
  exit 1
}
"$inventory_verifier" "$inventory" "$deb" "$rpm_file"

safe_tmp_root="${TMPDIR:-/tmp}"
[[ -d "$safe_tmp_root" && ! -L "$safe_tmp_root" ]] || {
  echo "sign-linux-artifacts: temporary root is missing or is a symlink" >&2
  exit 2
}
safe_tmp_root="$(readlink -f -- "$safe_tmp_root")"
[[ "$safe_tmp_root" == /* && "$safe_tmp_root" != / ]] || {
  echo "sign-linux-artifacts: temporary root is not a safe canonical directory" >&2
  exit 2
}
tmp_owner="$(stat -c '%u' -- "$safe_tmp_root")"
tmp_mode="$(stat -c '%a' -- "$safe_tmp_root")"
current_uid="$(id -u)"
if [[ "$tmp_owner" != "$current_uid" ]]; then
  # Shared roots are accepted only when root-owned, sticky, and world-writable.
  mode_value=$((8#$tmp_mode))
  if [[ "$tmp_owner" != 0 ]] || (( (mode_value & 01000) == 0 || (mode_value & 0002) == 0 )); then
    echo "sign-linux-artifacts: temporary root ownership/mode is unsafe" >&2
    exit 2
  fi
fi

private_root="$(mktemp -d "$safe_tmp_root/dsx-linux-release.XXXXXXXX")"
[[ -d "$private_root" && ! -L "$private_root" && "$private_root" == "$safe_tmp_root"/dsx-linux-release.* ]] || {
  echo "sign-linux-artifacts: private workspace creation escaped the temporary root" >&2
  exit 2
}
early_cleanup() {
  local original_status=$?
  local cleanup_status=0
  trap - EXIT INT TERM
  if [[ "$private_root" == "$safe_tmp_root"/dsx-linux-release.* ]]; then
    rm -rf -- "$private_root" || cleanup_status=1
  fi
  (( original_status != 0 )) && exit "$original_status"
  exit "$cleanup_status"
}
trap early_cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
chmod 700 "$private_root"
sign_home="$private_root/sign"
verify_home="$private_root/verify"
stage_dir="$private_root/stage"
mkdir -m 700 -- "$sign_home" "$verify_home" "$stage_dir"

key_file="$sign_home/private-key.asc"
stage_repository="$stage_dir/repository"
stage_reports="$stage_dir/reports"
stage_signatures="$stage_dir/signatures"
mkdir -m 700 -- "$stage_repository" "$stage_reports" "$stage_signatures"
published=()
publish_complete=0
cleanup() {
  local original_status=$?
  local cleanup_status=0
  local published_path
  trap - EXIT INT TERM
  set +e
  unset private_key_b64 passphrase DSX_LINUX_SIGNING_PRIVATE_KEY_B64 \
    DSX_LINUX_SIGNING_KEY_FINGERPRINT DSX_LINUX_SIGNING_PASSPHRASE
  for gpg_home in "$sign_home" "$verify_home"; do
    if [[ -d "$gpg_home" ]] && ! env -i HOME="$gpg_home" GNUPGHOME="$gpg_home" \
      LANG=C LC_ALL=C PATH=/usr/sbin:/usr/bin:/sbin:/bin TZ=UTC \
      gpgconf --homedir "$gpg_home" --kill all >/dev/null 2>&1; then
      echo "sign-linux-artifacts: failed to terminate isolated GnuPG agents" >&2
      cleanup_status=1
    fi
  done
  if [[ "$private_root" == "$safe_tmp_root"/dsx-linux-release.* &&
        -d "$private_root" && ! -L "$private_root" ]]; then
    rm -rf -- "$private_root" || cleanup_status=1
  else
    cleanup_status=1
  fi
  if (( original_status != 0 || publish_complete != 1 || cleanup_status != 0 )); then
    for published_path in "${published[@]}"; do
      [[ "$published_path" == "$build_dir"/* ]] || {
        echo "sign-linux-artifacts: refused unsafe rollback path $published_path" >&2
        cleanup_status=1
        continue
      }
      if [[ -e "$published_path" || -L "$published_path" ]] && ! rm -rf -- "$published_path"; then
        echo "sign-linux-artifacts: failed to roll back partial output $published_path" >&2
        cleanup_status=1
      fi
    done
  fi
  (( cleanup_status == 0 )) || echo "sign-linux-artifacts: private signing workspace cleanup failed" >&2
  if (( original_status != 0 )); then
    exit "$original_status"
  fi
  exit "$cleanup_status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

printf '%s' "$private_key_b64" | base64 --decode > "$key_file"
chmod 600 "$key_file"
gpg_env=(env -i HOME="$sign_home" GNUPGHOME="$sign_home" LANG=C LC_ALL=C PATH=/usr/bin:/bin TZ=UTC)
verify_gpg_env=(env -i HOME="$verify_home" GNUPGHOME="$verify_home" LANG=C LC_ALL=C PATH=/usr/bin:/bin TZ=UTC)
"${gpg_env[@]}" gpg --homedir "$sign_home" --batch --no-options --quiet --import "$key_file"
rm -f -- "$key_file"

mapfile -t imported_primary_fingerprints < <(
  "${gpg_env[@]}" gpg --homedir "$sign_home" --batch --no-options --with-colons --fingerprint --list-secret-keys 2>/dev/null |
    awk -F: '$1 == "sec" { want = 1; next } want && $1 == "fpr" { print toupper($10); want = 0 }'
)
[[ ${#imported_primary_fingerprints[@]} -eq 1 &&
   "${imported_primary_fingerprints[0]}" == "$expected_fingerprint" ]] || {
  echo "sign-linux-artifacts: key material must contain exactly one primary secret key matching the pinned fingerprint" >&2
  exit 1
}
"${verify_gpg_env[@]}" gpg --homedir "$verify_home" --batch --no-options --quiet \
  --import-options import-minimal --import "$trust_key"
mapfile -t pinned_primary_fingerprints < <(
  "${verify_gpg_env[@]}" gpg --homedir "$verify_home" --batch --no-options --with-colons --fingerprint --list-keys 2>/dev/null |
    awk -F: '$1 == "pub" { want = 1; next } want && $1 == "fpr" { print toupper($10); want = 0 }'
)
[[ ${#pinned_primary_fingerprints[@]} -eq 1 &&
   "${pinned_primary_fingerprints[0]}" == "$expected_fingerprint" ]] || {
  echo "sign-linux-artifacts: pinned public key does not contain exactly the policy primary key" >&2
  exit 1
}

package_name="$(dpkg-deb -f "$deb" Package)"
package_architecture="$(dpkg-deb -f "$deb" Architecture)"
[[ "$package_name" == "$app_id" && "$package_architecture" == amd64 ]] || {
  echo "sign-linux-artifacts: deb identity/architecture does not match immutable app identity" >&2
  exit 1
}
apt_root="$stage_repository/apt"
rpm_root="$stage_repository/rpm"
apt_pool="$apt_root/pool/main/${package_name:0:1}/$package_name"
apt_binary="$apt_root/dists/stable/main/binary-amd64"
mkdir -p -- "$apt_pool" "$apt_binary" "$rpm_root/x86_64"
install -m 0644 -- "$deb" "$apt_pool/$(basename "$deb")"
install -m 0644 -- "$rpm_file" "$rpm_root/x86_64/$(basename "$rpm_file")"
(
  cd "$apt_root"
  LC_ALL=C apt-ftparchive packages pool > "$apt_binary/Packages"
)
gzip -n -9 -c -- "$apt_binary/Packages" > "$apt_binary/Packages.gz"
mkdir -p -- "$apt_binary/by-hash/SHA256"
for metadata in "$apt_binary/Packages" "$apt_binary/Packages.gz"; do
  metadata_digest="$(sha256sum -- "$metadata" | awk '{print $1}')"
  install -m 0644 -- "$metadata" "$apt_binary/by-hash/SHA256/$metadata_digest"
done
createrepo_c --quiet --no-database --checksum sha256 --revision "$source_epoch" "$rpm_root"

python3 - "$apt_root/dists/stable/Release" "$source_epoch" "$apt_binary/Packages" "$apt_binary/Packages.gz" <<'PY'
import datetime as dt
import email.utils
import hashlib
import pathlib
import sys

output = pathlib.Path(sys.argv[1])
epoch = int(sys.argv[2])
root = output.parent
lines = [
    "Origin: DSX",
    "Label: DSX",
    "Suite: stable",
    "Codename: stable",
    "Date: " + email.utils.format_datetime(dt.datetime.fromtimestamp(epoch, dt.timezone.utc), usegmt=True),
    "Architectures: amd64",
    "Components: main",
    "Acquire-By-Hash: yes",
    "Description: DSX signed Linux desktop releases",
    "SHA256:",
]
for raw in sys.argv[3:]:
    path = pathlib.Path(raw)
    relative = path.relative_to(root).as_posix()
    data = path.read_bytes()
    lines.append(f" {hashlib.sha256(data).hexdigest()} {len(data)} {relative}")
with output.open("w", encoding="utf-8", newline="\n") as handle:
    handle.write("\n".join(lines) + "\n")
PY

# Reserve every public destination before signing. The repository remains under
# the private staging root until all of its metadata signatures exist and its
# public traversal modes have been normalized.
published_admission="$report_dir/linux-source-admission.json"
published_key="$report_dir/dsx-linux-signing-public-key.asc"
provenance="$report_dir/linux-release-provenance.json"
for destination in "$repository" "$published_admission" "$published_key" "$provenance" "$provenance.asc" \
  "$deb.asc" "$rpm_file.asc" "$inventory.asc"; do
  [[ ! -e "$destination" && ! -L "$destination" ]] || {
    echo "sign-linux-artifacts: refusing to overwrite existing release output $destination" >&2
    exit 1
  }
done
install -m 0644 -- "$source_admission" "$stage_reports/linux-source-admission.json"
install -m 0644 -- "$trust_key" "$stage_reports/dsx-linux-signing-public-key.asc"

sign_detached() {
  local source=$1
  local output=$2
  printf '%s' "$passphrase" | "${gpg_env[@]}" gpg --homedir "$sign_home" \
    --batch --no-options --yes --pinentry-mode loopback --passphrase-fd 0 \
    --local-user "$expected_fingerprint" --digest-algo SHA256 --armor --detach-sign \
    --output "$output" "$source"
}
sign_clearsigned() {
  local source=$1
  local output=$2
  printf '%s' "$passphrase" | "${gpg_env[@]}" gpg --homedir "$sign_home" \
    --batch --no-options --yes --pinentry-mode loopback --passphrase-fd 0 \
    --local-user "$expected_fingerprint" --digest-algo SHA256 --armor --clearsign \
    --output "$output" "$source"
}
verify_detached() {
  local signature=$1
  local source=$2
  local status
  status="$("${verify_gpg_env[@]}" gpg --homedir "$verify_home" --batch --no-options \
    --no-auto-key-retrieve --status-fd 1 --verify "$signature" "$source" 2>/dev/null)" || return 1
  awk -v expected="$expected_fingerprint" '
    $1 == "[GNUPG:]" && $2 == "VALIDSIG" && $10 == "8" && ($3 == expected || $NF == expected) { valid++ }
    $1 == "[GNUPG:]" && ($2 == "BADSIG" || $2 == "ERRSIG" || $2 == "EXPSIG" ||
      $2 == "EXPKEYSIG" || $2 == "REVKEYSIG" || $2 == "NO_PUBKEY") { bad = 1 }
    END { exit(valid == 1 && !bad ? 0 : 1) }
  ' <<< "$status"
}

deb_signature="$stage_signatures/deb.asc"
rpm_signature="$stage_signatures/rpm.asc"
inventory_signature="$stage_signatures/inventory.asc"
provenance_signature="$stage_signatures/provenance.asc"
apt_release="$stage_repository/apt/dists/stable/Release"
apt_release_signature="$stage_signatures/Release.gpg"
apt_inrelease="$stage_signatures/InRelease"
rpm_repomd="$stage_repository/rpm/repodata/repomd.xml"
rpm_repomd_signature="$stage_signatures/repomd.xml.asc"
sign_detached "$deb" "$deb_signature"
sign_detached "$rpm_file" "$rpm_signature"
sign_detached "$inventory" "$inventory_signature"
sign_detached "$apt_release" "$apt_release_signature"
sign_clearsigned "$apt_release" "$apt_inrelease"
sign_detached "$rpm_repomd" "$rpm_repomd_signature"
for pair in \
  "$deb_signature|$deb" "$rpm_signature|$rpm_file" "$inventory_signature|$inventory" \
  "$apt_release_signature|$apt_release" \
  "$rpm_repomd_signature|$rpm_repomd"; do
  verify_detached "${pair%%|*}" "${pair#*|}" || {
    echo "sign-linux-artifacts: independent pinned-key signature verification failed" >&2
    exit 1
  }
done
cleared="$stage_dir/apt-release.clear"
"${verify_gpg_env[@]}" gpg --homedir "$verify_home" --batch --no-options --no-auto-key-retrieve \
  --output "$cleared" --decrypt "$apt_inrelease" >/dev/null 2>&1
cmp -s -- "$cleared" "$apt_release" || {
  echo "sign-linux-artifacts: apt InRelease does not contain the exact Release bytes" >&2
  exit 1
}

for source_and_destination in \
  "$apt_release_signature|$stage_repository/apt/dists/stable/Release.gpg" \
  "$apt_inrelease|$stage_repository/apt/dists/stable/InRelease" \
  "$rpm_repomd_signature|$stage_repository/rpm/repodata/repomd.xml.asc"; do
  source_path="${source_and_destination%%|*}"
  destination="${source_and_destination#*|}"
  [[ ! -e "$destination" && ! -L "$destination" ]] || {
    echo "sign-linux-artifacts: refusing to overwrite staged repository signature $destination" >&2
    exit 1
  }
  mv -- "$source_path" "$destination"
done

# umask 077 protects all private state. Only the completed public apt/rpm
# repository is relaxed, while it is still inside the private staging root.
# Exact modes are subsequently enforced again by verify-linux-release.py.
normalize_public_repository() {
  local root=$1
  local path actual expected
  [[ "$root" == "$stage_repository" && -d "$root" && ! -L "$root" ]] || {
    echo "sign-linux-artifacts: refusing to normalize a non-staged repository" >&2
    return 1
  }
  while IFS= read -r -d '' path; do
    if [[ -L "$path" || (! -d "$path" && ! -f "$path") ]]; then
      echo "sign-linux-artifacts: staged public repository contains a link or special entry" >&2
      return 1
    fi
  done < <(find -P "$root" -xdev -print0)
  find -P "$root" -xdev -type d -exec chmod 0755 -- {} +
  find -P "$root" -xdev -type f -exec chmod 0644 -- {} +
  while IFS= read -r -d '' path; do
    if [[ -d "$path" && ! -L "$path" ]]; then
      expected=755
    elif [[ -f "$path" && ! -L "$path" ]]; then
      expected=644
    else
      echo "sign-linux-artifacts: staged public repository changed during mode verification" >&2
      return 1
    fi
    actual="$(stat -c '%a' -- "$path")"
    [[ "$actual" == "$expected" ]] || {
      echo "sign-linux-artifacts: staged public repository mode normalization failed" >&2
      return 1
    }
  done < <(find -P "$root" -xdev -print0)
}
normalize_public_repository "$stage_repository"

# Publish the completed repository and immutable trust/admission inputs. Any
# subsequent provenance/signature/verifier failure removes all published paths.
mv -- "$stage_repository" "$repository"
published+=("$repository")
mv -- "$stage_reports/linux-source-admission.json" "$published_admission"
published+=("$published_admission")
mv -- "$stage_reports/dsx-linux-signing-public-key.asc" "$published_key"
published+=("$published_key")

# Provenance is generated only after repository signatures and public modes are
# final. It therefore binds every apt/rpm metadata and repository signature byte
# that the public verifier will accept.
stage_provenance="$stage_reports/linux-release-provenance.json"
python3 - "$stage_provenance" "$desktop_dir" "$source_commit" "$source_tree" "$source_tag" \
  "$build_id" "$build_number" "$source_epoch" "$app_id" "$app_title" "$app_version" \
  "$app_release" "$app_build" "$expected_fingerprint" "$trust_key" "$published_admission" \
  "$deb" "$rpm_file" "$inventory" "$published_key" "$repository" <<'PY'
import hashlib
import json
import pathlib
import stat
import sys

(output_raw, desktop_raw, commit, tree, tag, build_id, build_number, source_epoch,
 app_id, title, version, release, app_build, fingerprint, trust_raw,
 admission_raw, deb_raw, rpm_raw, inventory_raw, published_key_raw, repository_raw) = sys.argv[1:]
output = pathlib.Path(output_raw)
desktop = pathlib.Path(desktop_raw)
trust = pathlib.Path(trust_raw)
admission = pathlib.Path(admission_raw)
subjects = [pathlib.Path(value) for value in (deb_raw, rpm_raw, inventory_raw, published_key_raw, admission_raw)]
repository = pathlib.Path(repository_raw)
for path in repository.rglob("*"):
    if path.is_file() and not path.is_symlink():
        subjects.append(path)

records = []
seen = set()
def digest(path):
    value = hashlib.sha256()
    with path.open("rb") as handle:
        while True:
            block = handle.read(1024 * 1024)
            if not block:
                break
            value.update(block)
    return value.hexdigest()

for path in sorted(subjects, key=lambda value: value.relative_to(desktop).as_posix()):
    mode = path.lstat().st_mode
    if not stat.S_ISREG(mode):
        raise SystemExit(f"non-regular Linux provenance subject: {path}")
    relative = path.relative_to(desktop).as_posix()
    if relative in seen:
        raise SystemExit(f"duplicate Linux provenance subject: {relative}")
    seen.add(relative)
    records.append({"path": relative, "sha256": digest(path), "size": path.stat().st_size})
payload = {
    "schema": "dev.dsx.linux-release-provenance/v1",
    "source": {
        "commit": commit,
        "tree": tree,
        "tag": tag,
        "admissionSha256": hashlib.sha256(admission.read_bytes()).hexdigest(),
    },
    "build": {"id": build_id, "number": build_number, "sourceEpoch": source_epoch},
    "identity": {
        "appId": app_id,
        "title": title,
        "version": version,
        "release": release,
        "appBuild": app_build,
    },
    "trust": {
        "fingerprint": fingerprint,
        "publicKeySha256": hashlib.sha256(trust.read_bytes()).hexdigest(),
    },
    "subjects": records,
}
output.write_text(json.dumps(payload, sort_keys=True, separators=(",", ":")) + "\n", encoding="utf-8")
PY
chmod 600 "$stage_provenance"
sign_detached "$stage_provenance" "$provenance_signature"
verify_detached "$provenance_signature" "$stage_provenance" || {
  echo "sign-linux-artifacts: independent provenance signature verification failed" >&2
  exit 1
}

mv -- "$stage_provenance" "$provenance"
published+=("$provenance")
for source_and_destination in \
  "$deb_signature|$deb.asc" "$rpm_signature|$rpm_file.asc" \
  "$inventory_signature|$inventory.asc" "$provenance_signature|$provenance.asc"; do
  source_path="${source_and_destination%%|*}"
  destination="${source_and_destination#*|}"
  [[ ! -e "$destination" && ! -L "$destination" ]] || {
    echo "sign-linux-artifacts: refusing to overwrite signature output $destination" >&2
    exit 1
  }
  mv -- "$source_path" "$destination"
  chmod 0644 "$destination"
  published+=("$destination")
done
chmod 0644 "$provenance" "$published_admission" "$published_key"

"$release_verifier" \
  --desktop-dir "$desktop_dir" \
  --trust-policy "$trust_policy" \
  --trust-key "$trust_key" \
  --expected-fingerprint "$expected_fingerprint" \
  --expected-commit "$source_commit" \
  --expected-tree "$source_tree" \
  --expected-tag "$source_tag" \
  --expected-build-id "$build_id" \
  --expected-build-number "$build_number" \
  --expected-source-epoch "$source_epoch" \
  --expected-app-id "$app_id" \
  --expected-title "$app_title" \
  --expected-version "$app_version" \
  --expected-release "$app_release" \
  --expected-app-build "$app_build"

publish_complete=1
echo "sign-linux-artifacts: pinned package/repository signatures and provenance verified with $expected_fingerprint"
