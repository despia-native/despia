#!/usr/bin/env python3
"""Fail-closed verifier for a signed DSX Linux package/repository release.

The verifier trusts only the Git-pinned OpenPGP key and policy.  It performs no
key discovery and does not use a caller's GnuPG configuration.  Package bytes,
apt/rpm repository copies, repository metadata, clean-source admission, and the
signed provenance statement are bound to one immutable tag build.
"""

from __future__ import annotations

import argparse
import datetime as dt
import gzip
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import xml.etree.ElementTree as ET


class VerificationError(RuntimeError):
    pass


FINGERPRINT_RE = re.compile(r"[0-9A-F]{40}")
OID_RE = re.compile(r"[0-9a-f]{40,64}")
SHA256_RE = re.compile(r"[0-9a-f]{64}")
TAG_RE = re.compile(r"v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)")
BUILD_VALUE_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}")
APP_ID_RE = re.compile(r"[a-z0-9][a-z0-9.-]{1,127}")
VERSION_RE = re.compile(r"(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)")
TITLE_RE = re.compile(r"[A-Za-z0-9](?:[A-Za-z0-9 ._-]{0,62}[A-Za-z0-9._-])?")
MAX_JSON_BYTES = 2 * 1024 * 1024
MAX_METADATA_BYTES = 64 * 1024 * 1024


def _reject_duplicate_pairs(pairs: list[tuple[str, object]]) -> dict[str, object]:
    result: dict[str, object] = {}
    for key, value in pairs:
        if key in result:
            raise VerificationError(f"JSON contains duplicate key {key!r}")
        result[key] = value
    return result


def strict_json(path: Path, *, maximum: int = MAX_JSON_BYTES) -> object:
    raw = read_regular(path, maximum=maximum)
    try:
        return json.loads(
            raw.decode("utf-8", errors="strict"),
            object_pairs_hook=_reject_duplicate_pairs,
            parse_constant=lambda value: (_ for _ in ()).throw(
                VerificationError(f"JSON contains non-standard value {value}")
            ),
        )
    except (UnicodeDecodeError, json.JSONDecodeError, RecursionError) as error:
        raise VerificationError(f"invalid JSON in {path}: {error}") from error


def regular_info(path: Path, *, maximum: int | None = None) -> os.stat_result:
    try:
        info = path.lstat()
    except FileNotFoundError as error:
        raise VerificationError(f"required file is missing: {path}") from error
    if not stat.S_ISREG(info.st_mode):
        raise VerificationError(f"required path is not a regular file: {path}")
    if maximum is not None and info.st_size > maximum:
        raise VerificationError(f"file exceeds the {maximum}-byte bound: {path}")
    return info


def read_regular(path: Path, *, maximum: int | None = None) -> bytes:
    regular_info(path, maximum=maximum)
    with path.open("rb") as handle:
        return handle.read()


def reject_symlink_tree(root: Path) -> None:
    try:
        info = root.lstat()
    except FileNotFoundError as error:
        raise VerificationError(f"required directory is missing: {root}") from error
    if not stat.S_ISDIR(info.st_mode) or stat.S_ISLNK(info.st_mode):
        raise VerificationError(f"release directory is missing or unsafe: {root}")
    for path in root.rglob("*"):
        if path.is_symlink():
            raise VerificationError(f"release tree contains a symbolic link: {path}")


def validate_public_repository_tree(root: Path) -> None:
    """Require a directly publishable, immutable-by-default repository tree.

    The signer intentionally keeps its GnuPG homes and staging parent private,
    but apt/rpm clients must be able to traverse the published repository.  Do
    not accept a tree that merely has valid bytes: exact public modes are part
    of the release contract, and links/special files could change what a later
    publisher serves without changing the provenance inventory.
    """

    try:
        root_info = root.lstat()
    except FileNotFoundError as error:
        raise VerificationError(f"required directory is missing: {root}") from error
    if not stat.S_ISDIR(root_info.st_mode) or stat.S_ISLNK(root_info.st_mode):
        raise VerificationError(f"release directory is missing or unsafe: {root}")
    if stat.S_IMODE(root_info.st_mode) != 0o755:
        raise VerificationError(f"public repository directory mode must be 0755: {root}")

    for path in root.rglob("*"):
        info = path.lstat()
        if stat.S_ISLNK(info.st_mode):
            raise VerificationError(f"release tree contains a symbolic link: {path}")
        if stat.S_ISDIR(info.st_mode):
            if stat.S_IMODE(info.st_mode) != 0o755:
                raise VerificationError(f"public repository directory mode must be 0755: {path}")
        elif stat.S_ISREG(info.st_mode):
            if stat.S_IMODE(info.st_mode) != 0o644:
                raise VerificationError(f"public repository file mode must be 0644: {path}")
        else:
            raise VerificationError(f"public repository contains a special filesystem entry: {path}")


def sha256_file(path: Path) -> str:
    regular_info(path)
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while True:
            block = handle.read(1024 * 1024)
            if not block:
                break
            digest.update(block)
    return digest.hexdigest()


def bounded_gzip(path: Path, *, maximum: int = MAX_METADATA_BYTES) -> bytes:
    compressed = read_regular(path, maximum=maximum)
    try:
        with gzip.GzipFile(fileobj=io.BytesIO(compressed), mode="rb") as archive:
            expanded = archive.read(maximum + 1)
    except (OSError, EOFError) as error:
        raise VerificationError(f"invalid gzip metadata: {path}") from error
    if len(expanded) > maximum:
        raise VerificationError(f"gzip metadata expands beyond the {maximum}-byte bound: {path}")
    return expanded


def canonical_relative(value: object) -> str:
    if not isinstance(value, str) or not value or len(value) > 1024:
        raise VerificationError("release path must be a non-empty bounded string")
    if "\\" in value or "\x00" in value or value.startswith("/"):
        raise VerificationError(f"unsafe release path: {value!r}")
    path = PurePosixPath(value)
    if str(path) != value or any(part in ("", ".", "..") for part in path.parts):
        raise VerificationError(f"non-canonical release path: {value!r}")
    return value


def decode_utf8(raw: bytes, label: str) -> str:
    try:
        return raw.decode("utf-8", errors="strict")
    except UnicodeDecodeError as error:
        raise VerificationError(f"{label} is not valid UTF-8") from error


def exact_object(value: object, keys: set[str], label: str) -> dict[str, object]:
    if not isinstance(value, dict) or set(value) != keys:
        actual = sorted(value) if isinstance(value, dict) else type(value).__name__
        raise VerificationError(f"{label} fields are not exact: {actual}")
    return value


def parse_utc(value: object, label: str) -> dt.datetime:
    if not isinstance(value, str) or not value.endswith("Z"):
        raise VerificationError(f"{label} must be an RFC3339 UTC timestamp")
    try:
        parsed = dt.datetime.fromisoformat(value[:-1] + "+00:00")
    except ValueError as error:
        raise VerificationError(f"{label} is not a valid timestamp") from error
    if parsed.microsecond:
        raise VerificationError(f"{label} must not contain fractional seconds")
    return parsed


def validate_trust_policy(
    policy_path: Path,
    key_path: Path,
    *,
    now: dt.datetime | None = None,
) -> tuple[str, str]:
    policy = exact_object(
        strict_json(policy_path),
        {
            "schema",
            "status",
            "primaryFingerprint",
            "publicKey",
            "publicKeySha256",
            "validFrom",
            "validUntil",
        },
        "Linux signing trust policy",
    )
    if policy["schema"] != "dev.dsx.linux-signing-trust/v1" or policy["status"] != "active":
        raise VerificationError("Linux signing trust policy is not an active v1 policy")
    fingerprint = str(policy["primaryFingerprint"])
    if not FINGERPRINT_RE.fullmatch(fingerprint):
        raise VerificationError("Linux signing trust policy fingerprint is invalid")
    if policy["publicKey"] != "linux-signing-public-key.asc":
        raise VerificationError("Linux signing trust policy key path is not canonical")
    key_digest = sha256_file(key_path)
    if policy["publicKeySha256"] != key_digest:
        raise VerificationError("pinned Linux public-key digest does not match the committed key")
    key_bytes = read_regular(key_path, maximum=1024 * 1024)
    if b"PRIVATE KEY" in key_bytes or b"SECRET KEY" in key_bytes:
        raise VerificationError("pinned Linux trust anchor contains private-key material")
    valid_from = parse_utc(policy["validFrom"], "trust validFrom")
    valid_until = parse_utc(policy["validUntil"], "trust validUntil")
    instant = now or dt.datetime.now(dt.timezone.utc)
    if not valid_from <= instant < valid_until:
        raise VerificationError("pinned Linux signing trust anchor is outside its validity window")
    return fingerprint, key_digest


def safe_environment(home: Path) -> dict[str, str]:
    return {
        "GNUPGHOME": os.fspath(home),
        "HOME": os.fspath(home),
        "LANG": "C",
        "LC_ALL": "C",
        "PATH": "/usr/bin:/bin",
        "TZ": "UTC",
    }


class GpgVerifier:
    def __init__(
        self,
        executable: Path,
        public_key: Path,
        fingerprint: str,
        *,
        minimum_signature_epoch: int | None = None,
    ):
        executable = executable.resolve(strict=True)
        info = executable.stat()
        if (
            not stat.S_ISREG(info.st_mode)
            or not os.access(executable, os.X_OK)
            or info.st_mode & (stat.S_IWGRP | stat.S_IWOTH)
        ):
            raise VerificationError("gpg verifier is not an executable regular file")
        self.executable = executable
        self.public_key = public_key
        self.fingerprint = fingerprint
        self.minimum_signature_epoch = minimum_signature_epoch
        self._temporary: tempfile.TemporaryDirectory[str] | None = None
        self.home: Path | None = None

    def __enter__(self) -> "GpgVerifier":
        self._temporary = tempfile.TemporaryDirectory(prefix="dsx-linux-public-verify-")
        self.home = Path(self._temporary.name)
        self.home.chmod(0o700)
        result = self._run(
            "--batch", "--no-options", "--quiet", "--import-options", "import-minimal",
            "--import", os.fspath(self.public_key),
        )
        if result.returncode != 0:
            raise VerificationError("cannot import the pinned Linux public key")
        listing = self._run("--batch", "--no-options", "--with-colons", "--fingerprint", "--list-keys")
        if listing.returncode != 0:
            raise VerificationError("cannot inspect the pinned Linux public key")
        primary: list[str] = []
        want_fingerprint = False
        for line in decode_utf8(listing.stdout, "gpg key listing").splitlines():
            fields = line.split(":")
            if fields[0] == "pub":
                if len(fields) < 12 or "r" in fields[1] or "e" in fields[1] or "d" in fields[1]:
                    raise VerificationError("pinned Linux public key is revoked, expired, or disabled")
                want_fingerprint = True
            elif want_fingerprint and fields[0] == "fpr":
                primary.append(fields[9].upper())
                want_fingerprint = False
        if primary != [self.fingerprint]:
            raise VerificationError("pinned Linux key does not contain exactly the policy primary fingerprint")
        secret = self._run("--batch", "--no-options", "--with-colons", "--list-secret-keys")
        if secret.returncode != 0:
            raise VerificationError("cannot inspect the public verification keyring for secret keys")
        if b"sec:" in secret.stdout:
            raise VerificationError("public verification keyring unexpectedly contains a secret key")
        return self

    def __exit__(self, *_: object) -> None:
        if self._temporary is not None:
            self._temporary.cleanup()
        self.home = None

    def _run(self, *arguments: str) -> subprocess.CompletedProcess[bytes]:
        if self.home is None:
            raise VerificationError("gpg verifier is not initialized")
        return subprocess.run(
            [os.fspath(self.executable), "--homedir", os.fspath(self.home), *arguments],
            env=safe_environment(self.home),
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
            timeout=60,
        )

    def _validate_status(self, status: bytes, label: str) -> None:
        valid: list[list[str]] = []
        forbidden = {
            "BADSIG", "ERRSIG", "EXPSIG", "EXPKEYSIG", "REVKEYSIG", "NO_PUBKEY",
            "KEYEXPIRED", "SIGEXPIRED", "KEYREVOKED",
        }
        for line in decode_utf8(status, f"{label} gpg status").splitlines():
            if not line.startswith("[GNUPG:] "):
                continue
            fields = line.split()
            if len(fields) >= 2 and fields[1] in forbidden:
                raise VerificationError(f"{label} has invalid OpenPGP status {fields[1]}")
            if len(fields) >= 2 and fields[1] == "VALIDSIG":
                valid.append(fields)
        if len(valid) != 1:
            raise VerificationError(f"{label} must contain exactly one valid OpenPGP signature")
        fields = valid[0]
        # VALIDSIG: signing fpr, date, timestamp, expiry, version, reserved,
        # public-key algorithm, hash algorithm, signature class, primary fpr.
        if len(fields) < 12 or fields[9] != "8":
            raise VerificationError(f"{label} must use SHA-256 OpenPGP signatures")
        signing = fields[2].upper()
        primary = fields[-1].upper()
        if self.fingerprint not in (signing, primary):
            raise VerificationError(f"{label} is not signed by the pinned Linux key")
        try:
            signature_epoch = int(fields[4])
        except ValueError as error:
            raise VerificationError(f"{label} has an invalid OpenPGP signature timestamp") from error
        now_epoch = int(dt.datetime.now(dt.timezone.utc).timestamp())
        if signature_epoch > now_epoch + 300:
            raise VerificationError(f"{label} OpenPGP signature timestamp is in the future")
        if self.minimum_signature_epoch is not None and signature_epoch < self.minimum_signature_epoch:
            raise VerificationError(f"{label} OpenPGP signature predates the admitted release source")

    def detached(self, signature: Path, target: Path, label: str) -> None:
        read_regular(signature, maximum=4 * 1024 * 1024)
        read_regular(target)
        result = self._run(
            "--batch", "--no-options", "--no-auto-key-retrieve", "--status-fd", "1",
            "--verify", os.fspath(signature), os.fspath(target),
        )
        if result.returncode != 0:
            raise VerificationError(f"{label} OpenPGP verification failed")
        self._validate_status(result.stdout, label)

    def clearsigned(self, signed: Path, expected: Path, label: str) -> None:
        read_regular(signed, maximum=MAX_METADATA_BYTES)
        expected_bytes = read_regular(expected, maximum=MAX_METADATA_BYTES)
        result = self._run(
            "--batch", "--no-options", "--no-auto-key-retrieve", "--status-fd", "2",
            "--decrypt", os.fspath(signed),
        )
        if result.returncode != 0 or result.stdout != expected_bytes:
            raise VerificationError(f"{label} clear-signed content does not match Release")
        self._validate_status(result.stderr, label)


def parse_checksum_inventory(inventory: Path, expected: dict[str, Path]) -> None:
    text = decode_utf8(read_regular(inventory, maximum=1024 * 1024), "Linux checksum inventory")
    lines = text.splitlines()
    if len(lines) != len(expected) or text != "\n".join(lines) + "\n":
        raise VerificationError("Linux checksum inventory is not exact LF-terminated records")
    records: dict[str, str] = {}
    for line in lines:
        match = re.fullmatch(r"([0-9a-f]{64})  ([^\x00\r\n]+)", line)
        if not match:
            raise VerificationError("Linux checksum inventory contains a malformed record")
        name = canonical_relative(match.group(2))
        if name in records:
            raise VerificationError("Linux checksum inventory contains a duplicate path")
        records[name] = match.group(1)
    if set(records) != set(expected):
        raise VerificationError("Linux checksum inventory paths do not exactly match deb/rpm outputs")
    for name, path in expected.items():
        if records[name] != sha256_file(path):
            raise VerificationError(f"Linux checksum inventory digest mismatch for {name}")


def parse_control(text: str, label: str) -> dict[str, str]:
    fields: dict[str, str] = {}
    previous: str | None = None
    for line in text.splitlines():
        if line.startswith((" ", "\t")):
            if previous is None:
                raise VerificationError(f"{label} has an orphan continuation")
            fields[previous] += "\n" + line
            continue
        if ": " not in line:
            raise VerificationError(f"{label} contains malformed field {line!r}")
        key, value = line.split(": ", 1)
        if not re.fullmatch(r"[A-Za-z][A-Za-z0-9-]*", key) or key in fields:
            raise VerificationError(f"{label} contains duplicate or invalid field {key!r}")
        fields[key] = value
        previous = key
    return fields


def validate_apt_repository(
    apt_root: Path,
    expected_deb: Path,
    expected_app_id: str,
    expected_version: str,
    expected_release: str,
) -> set[Path]:
    pool_matches = list(apt_root.glob("pool/main/*/*/*.deb"))
    if len(pool_matches) != 1:
        raise VerificationError("apt repository must contain exactly one deb")
    pool_deb = pool_matches[0]
    if sha256_file(pool_deb) != sha256_file(expected_deb):
        raise VerificationError("apt repository deb differs from the verified package")
    package_rel = pool_deb.relative_to(apt_root).as_posix()
    packages = apt_root / "dists/stable/main/binary-amd64/Packages"
    packages_gz = packages.with_name("Packages.gz")
    release = apt_root / "dists/stable/Release"
    raw_packages = read_regular(packages, maximum=MAX_METADATA_BYTES)
    if b"\n\n" in raw_packages.rstrip(b"\n"):
        raise VerificationError("apt Packages must describe exactly one package")
    fields = parse_control(decode_utf8(raw_packages, "apt Packages").rstrip("\n"), "apt Packages")
    required = {"Package", "Version", "Architecture", "Filename", "Size", "SHA256"}
    if not required.issubset(fields):
        raise VerificationError("apt Packages is missing identity or digest fields")
    if (
        fields["Package"] != expected_app_id
        or fields["Version"] != f"{expected_version}-{expected_release}"
        or fields["Architecture"] != "amd64"
    ):
        raise VerificationError("apt Packages identity, version, release, or architecture is wrong")
    if canonical_relative(fields["Filename"]) != package_rel:
        raise VerificationError("apt Packages points outside the canonical pool package")
    if fields["SHA256"] != sha256_file(pool_deb) or fields["Size"] != str(pool_deb.stat().st_size):
        raise VerificationError("apt Packages does not bind the exact deb bytes")
    expanded = bounded_gzip(packages_gz)
    if expanded != raw_packages:
        raise VerificationError("apt Packages.gz does not reproduce Packages exactly")

    release_text = decode_utf8(read_regular(release, maximum=MAX_METADATA_BYTES), "apt Release")
    if "\nSHA256:\n" not in release_text:
        raise VerificationError("apt Release has no SHA256 section")
    header_text, checksum_text = release_text.split("\nSHA256:\n", 1)
    headers = parse_control(header_text, "apt Release")
    if (
        headers.get("Suite") != "stable"
        or headers.get("Codename") != "stable"
        or headers.get("Acquire-By-Hash") != "yes"
    ):
        raise VerificationError("apt Release suite/codename/by-hash policy is invalid")
    expected_metadata = {
        "main/binary-amd64/Packages": packages,
        "main/binary-amd64/Packages.gz": packages_gz,
    }
    seen: dict[str, str] = {}
    for line in checksum_text.splitlines():
        match = re.fullmatch(r" ([0-9a-f]{64}) ([0-9]+) (\S+)", line)
        if not match:
            raise VerificationError("apt Release contains a malformed SHA256 record")
        relative = canonical_relative(match.group(3))
        if relative in seen:
            raise VerificationError("apt Release contains a duplicate SHA256 path")
        seen[relative] = match.group(1)
        target = expected_metadata.get(relative)
        if target is None or int(match.group(2)) != target.stat().st_size:
            raise VerificationError("apt Release contains an unexpected path or size")
        if match.group(1) != sha256_file(target):
            raise VerificationError(f"apt Release digest mismatch for {relative}")
    if set(seen) != set(expected_metadata):
        raise VerificationError("apt Release does not contain the exact metadata inventory")
    by_hash_files: set[Path] = set()
    by_hash_root = packages.parent / "by-hash/SHA256"
    for target in expected_metadata.values():
        digest = sha256_file(target)
        by_hash = by_hash_root / digest
        if sha256_file(by_hash) != digest or by_hash.stat().st_size != target.stat().st_size:
            raise VerificationError("apt by-hash metadata does not reproduce the signed canonical metadata")
        by_hash_files.add(by_hash)
    actual_by_hash = {path for path in by_hash_root.glob("*") if path.is_file()}
    if actual_by_hash != by_hash_files:
        raise VerificationError("apt repository contains an unexpected by-hash object")
    return {pool_deb, packages, packages_gz, release} | by_hash_files


def validate_rpm_repository(
    rpm_root: Path,
    expected_rpm: Path,
    expected_app_id: str,
    expected_version: str,
    expected_release: str,
    expected_revision: str,
) -> set[Path]:
    package_matches = list(rpm_root.glob("x86_64/*.rpm"))
    if len(package_matches) != 1:
        raise VerificationError("rpm repository must contain exactly one rpm")
    repository_rpm = package_matches[0]
    if sha256_file(repository_rpm) != sha256_file(expected_rpm):
        raise VerificationError("rpm repository package differs from the verified rpm")
    repomd = rpm_root / "repodata/repomd.xml"
    raw = read_regular(repomd, maximum=MAX_METADATA_BYTES)
    upper = raw.upper()
    if b"<!DOCTYPE" in upper or b"<!ENTITY" in upper:
        raise VerificationError("rpm repomd.xml contains forbidden DTD/entity syntax")
    try:
        root = ET.fromstring(raw)
    except ET.ParseError as error:
        raise VerificationError("rpm repomd.xml is invalid XML") from error
    namespace = "{http://linux.duke.edu/metadata/repo}"
    if root.tag != namespace + "repomd":
        raise VerificationError("rpm repomd.xml uses an unexpected root/namespace")
    children = list(root)
    revisions = [child for child in children if child.tag == namespace + "revision"]
    if len(revisions) != 1 or revisions[0].text != expected_revision:
        raise VerificationError("rpm repomd.xml revision does not match the admitted source epoch")
    if any(child.tag not in {namespace + "revision", namespace + "data"} for child in children):
        raise VerificationError("rpm repomd.xml contains an unexpected top-level element")
    files = {repository_rpm, repomd}
    types: set[str] = set()
    primary_metadata: Path | None = None
    for data in root.findall(namespace + "data"):
        kind = data.get("type", "")
        if not kind or kind in types:
            raise VerificationError("rpm repomd.xml has duplicate or missing data types")
        types.add(kind)
        location = data.find(namespace + "location")
        checksum = data.find(namespace + "checksum")
        size = data.find(namespace + "size")
        if location is None or checksum is None or size is None:
            raise VerificationError("rpm repomd.xml data is missing location/checksum/size")
        relative = canonical_relative(location.get("href"))
        if not relative.startswith("repodata/") or checksum.get("type") != "sha256":
            raise VerificationError("rpm repomd.xml metadata reference is unsafe or not SHA-256")
        target = rpm_root / relative
        if checksum.text != sha256_file(target) or size.text != str(target.stat().st_size):
            raise VerificationError(f"rpm repomd.xml does not bind {relative}")
        files.add(target)
        if kind == "primary":
            primary_metadata = target
    if types != {"primary", "filelists", "other"}:
        raise VerificationError("rpm repomd.xml does not contain the exact primary/filelists/other metadata set")
    if primary_metadata is None or not primary_metadata.name.endswith(".xml.gz"):
        raise VerificationError("rpm primary metadata must be a gzip-compressed XML document")
    primary_raw = bounded_gzip(primary_metadata)
    primary_upper = primary_raw.upper()
    if b"<!DOCTYPE" in primary_upper or b"<!ENTITY" in primary_upper:
        raise VerificationError("rpm primary metadata contains forbidden DTD/entity syntax")
    try:
        primary_root = ET.fromstring(primary_raw)
    except ET.ParseError as error:
        raise VerificationError("rpm primary metadata is invalid XML") from error
    common = "{http://linux.duke.edu/metadata/common}"
    if primary_root.tag != common + "metadata" or primary_root.get("packages") != "1":
        raise VerificationError("rpm primary metadata must declare exactly one package")
    packages = primary_root.findall(common + "package")
    if len(packages) != 1 or packages[0].get("type") != "rpm":
        raise VerificationError("rpm primary metadata does not contain exactly one rpm package")
    package = packages[0]
    name = package.find(common + "name")
    architecture = package.find(common + "arch")
    version = package.find(common + "version")
    checksum = package.find(common + "checksum")
    location = package.find(common + "location")
    size = package.find(common + "size")
    if any(value is None for value in (name, architecture, version, checksum, location, size)):
        raise VerificationError("rpm primary metadata is missing package identity/digest fields")
    assert name is not None and architecture is not None and version is not None
    assert checksum is not None and location is not None and size is not None
    if (
        name.text != expected_app_id
        or architecture.text != "x86_64"
        or version.get("ver") != expected_version
        or version.get("rel") != expected_release
    ):
        raise VerificationError("rpm primary metadata identity, version, release, or architecture is wrong")
    package_relative = canonical_relative(location.get("href"))
    expected_relative = repository_rpm.relative_to(rpm_root).as_posix()
    if package_relative != expected_relative:
        raise VerificationError("rpm primary metadata points outside the canonical package")
    if (
        checksum.get("type") != "sha256"
        or checksum.get("pkgid") != "YES"
        or checksum.text != sha256_file(repository_rpm)
        or size.get("package") != str(repository_rpm.stat().st_size)
    ):
        raise VerificationError("rpm primary metadata does not bind the exact rpm bytes")
    return files


def validate_source_admission(path: Path, commit: str, tree: str) -> str:
    value = exact_object(
        strict_json(path),
        {"ok", "mode", "root", "head", "tree", "passes", "failures"},
        "Linux clean source admission",
    )
    if value["ok"] is not True or value["mode"] != "checkout":
        raise VerificationError("Linux clean source admission did not pass checkout mode")
    if value["head"] != commit or value["tree"] != tree or value["failures"] != []:
        raise VerificationError("Linux clean source admission does not match release source")
    if (
        not isinstance(value["root"], str)
        or not value["root"].startswith("/")
        or not isinstance(value["passes"], list)
        or len(value["passes"]) < 9
        or any(not isinstance(item, str) or not item for item in value["passes"])
        or len(set(value["passes"])) != len(value["passes"])
    ):
        raise VerificationError("Linux clean source admission is incomplete")
    return sha256_file(path)


def validate_provenance(
    path: Path,
    *,
    expected: dict[str, str],
    trust_fingerprint: str,
    trust_digest: str,
    admission_digest: str,
    required_subjects: set[Path],
    desktop_dir: Path,
) -> None:
    root = exact_object(
        strict_json(path),
        {"schema", "source", "build", "identity", "trust", "subjects"},
        "Linux release provenance",
    )
    if root["schema"] != "dev.dsx.linux-release-provenance/v1":
        raise VerificationError("Linux release provenance schema is invalid")
    source = exact_object(root["source"], {"commit", "tree", "tag", "admissionSha256"}, "provenance source")
    build = exact_object(root["build"], {"id", "number", "sourceEpoch"}, "provenance build")
    identity = exact_object(
        root["identity"], {"appId", "title", "version", "release", "appBuild"}, "provenance identity"
    )
    trust = exact_object(root["trust"], {"fingerprint", "publicKeySha256"}, "provenance trust")
    for field in ("commit", "tree", "tag"):
        if source[field] != expected[field]:
            raise VerificationError(f"Linux provenance source {field} mismatch")
    if source["admissionSha256"] != admission_digest:
        raise VerificationError("Linux provenance source-admission digest mismatch")
    for field in ("id", "number", "sourceEpoch"):
        if str(build[field]) != expected[field]:
            raise VerificationError(f"Linux provenance build {field} mismatch")
    identity_expected = {
        "appId": expected["appId"],
        "title": expected["title"],
        "version": expected["version"],
        "release": expected["release"],
        "appBuild": expected["appBuild"],
    }
    if identity != identity_expected:
        raise VerificationError("Linux provenance app identity mismatch")
    if trust != {"fingerprint": trust_fingerprint, "publicKeySha256": trust_digest}:
        raise VerificationError("Linux provenance trust binding mismatch")
    subjects = root["subjects"]
    if not isinstance(subjects, list):
        raise VerificationError("Linux provenance subjects must be an array")
    expected_paths = {path.relative_to(desktop_dir).as_posix(): path for path in required_subjects}
    seen: set[str] = set()
    for record in subjects:
        item = exact_object(record, {"path", "sha256", "size"}, "provenance subject")
        relative = canonical_relative(item["path"])
        if relative in seen or relative not in expected_paths:
            raise VerificationError("Linux provenance contains duplicate or unexpected subject")
        target = expected_paths[relative]
        if (
            not isinstance(item["sha256"], str)
            or not SHA256_RE.fullmatch(item["sha256"])
            or not isinstance(item["size"], int)
            or isinstance(item["size"], bool)
            or item["size"] < 0
            or item["sha256"] != sha256_file(target)
            or item["size"] != target.stat().st_size
        ):
            raise VerificationError(f"Linux provenance subject mismatch for {relative}")
        seen.add(relative)
    if seen != set(expected_paths):
        raise VerificationError("Linux provenance omits required release subjects")


def one_file(directory: Path, pattern: str, label: str) -> Path:
    matches = list(directory.glob(pattern))
    if len(matches) != 1:
        raise VerificationError(f"expected exactly one {label}; found {len(matches)}")
    return matches[0]


def verify(arguments: argparse.Namespace) -> None:
    if arguments.desktop_dir.is_symlink():
        raise VerificationError("desktop release root must not be a symbolic link")
    desktop_dir = arguments.desktop_dir.resolve(strict=True)
    if desktop_dir.name != "desktop" or desktop_dir.is_symlink():
        raise VerificationError("desktop release root is not canonical")
    if arguments.trust_key.is_symlink() or arguments.trust_policy.is_symlink():
        raise VerificationError("Linux signing trust inputs must not be symbolic links")
    key_path = arguments.trust_key.resolve(strict=True)
    policy_path = arguments.trust_policy.resolve(strict=True)
    fingerprint, key_digest = validate_trust_policy(policy_path, key_path)
    if arguments.expected_fingerprint and fingerprint != arguments.expected_fingerprint.upper():
        raise VerificationError("protected signing fingerprint does not match the pinned trust policy")

    expected = {
        "commit": arguments.expected_commit,
        "tree": arguments.expected_tree,
        "tag": arguments.expected_tag,
        "id": arguments.expected_build_id,
        "number": arguments.expected_build_number,
        "sourceEpoch": arguments.expected_source_epoch,
        "appId": arguments.expected_app_id,
        "title": arguments.expected_title,
        "version": arguments.expected_version,
        "release": arguments.expected_release,
        "appBuild": arguments.expected_app_build,
    }
    if not OID_RE.fullmatch(expected["commit"]) or not OID_RE.fullmatch(expected["tree"]):
        raise VerificationError("expected Linux source identity is invalid")
    if not TAG_RE.fullmatch(expected["tag"]):
        raise VerificationError("expected Linux tag is invalid")
    if not all(BUILD_VALUE_RE.fullmatch(expected[field]) for field in ("id", "number", "appBuild")):
        raise VerificationError("expected Linux build identity is invalid")
    if (
        not re.fullmatch(r"[0-9]{9,12}", expected["sourceEpoch"])
        or int(expected["sourceEpoch"]) > int(dt.datetime.now(dt.timezone.utc).timestamp()) + 300
        or not APP_ID_RE.fullmatch(expected["appId"])
        or not TITLE_RE.fullmatch(expected["title"])
    ):
        raise VerificationError("expected Linux source epoch or app ID is invalid")
    if not VERSION_RE.fullmatch(expected["version"]) or not re.fullmatch(r"[1-9][0-9]*", expected["release"]):
        raise VerificationError("expected Linux package version/release is invalid")

    build = desktop_dir / "build"
    validate_public_repository_tree(build / "repository")
    deb = one_file(build / "compose/binaries/main/deb", "*.deb", "deb")
    rpm = one_file(build / "compose/binaries/main/rpm", "*.rpm", "rpm")
    reports = build / "reports"
    inventory = reports / "linux-package-sha256.txt"
    admission = reports / "linux-source-admission.json"
    provenance = reports / "linux-release-provenance.json"
    published_key = reports / "dsx-linux-signing-public-key.asc"
    if read_regular(published_key, maximum=1024 * 1024) != read_regular(key_path, maximum=1024 * 1024):
        raise VerificationError("published Linux trust anchor differs from the Git-pinned key")

    deb_relative = "desktop/" + deb.relative_to(desktop_dir).as_posix()
    rpm_relative = "desktop/" + rpm.relative_to(desktop_dir).as_posix()
    parse_checksum_inventory(inventory, {deb_relative: deb, rpm_relative: rpm})
    admission_digest = validate_source_admission(admission, expected["commit"], expected["tree"])
    apt_files = validate_apt_repository(
        build / "repository/apt", deb, expected["appId"], expected["version"], expected["release"]
    )
    rpm_files = validate_rpm_repository(
        build / "repository/rpm", rpm, expected["appId"], expected["version"], expected["release"],
        expected["sourceEpoch"],
    )
    apt_signature_files = {
        build / "repository/apt/dists/stable/Release.gpg",
        build / "repository/apt/dists/stable/InRelease",
    }
    rpm_signature_files = {build / "repository/rpm/repodata/repomd.xml.asc"}
    for signature in apt_signature_files | rpm_signature_files:
        read_regular(signature, maximum=4 * 1024 * 1024)
    actual_apt_files = {
        path for path in (build / "repository/apt").rglob("*") if path.is_file()
    }
    actual_rpm_files = {
        path for path in (build / "repository/rpm").rglob("*") if path.is_file()
    }
    if actual_apt_files != apt_files | apt_signature_files:
        raise VerificationError("apt repository contains an unsigned or unexpected file")
    if actual_rpm_files != rpm_files | rpm_signature_files:
        raise VerificationError("rpm repository contains an unsigned or unexpected file")
    required_subjects = (
        {deb, rpm, inventory, admission, published_key}
        | apt_files
        | rpm_files
        | apt_signature_files
        | rpm_signature_files
    )
    validate_provenance(
        provenance,
        expected=expected,
        trust_fingerprint=fingerprint,
        trust_digest=key_digest,
        admission_digest=admission_digest,
        required_subjects=required_subjects,
        desktop_dir=desktop_dir,
    )

    gpg_path = arguments.gpg or Path(shutil.which("gpg") or "")
    if not os.fspath(gpg_path):
        raise VerificationError("gpg is required for Linux release verification")
    with GpgVerifier(
        gpg_path,
        key_path,
        fingerprint,
        minimum_signature_epoch=int(expected["sourceEpoch"]),
    ) as gpg:
        for target in (deb, rpm, inventory, provenance):
            gpg.detached(target.with_name(target.name + ".asc"), target, target.name)
        apt_release = build / "repository/apt/dists/stable/Release"
        gpg.detached(apt_release.with_name("Release.gpg"), apt_release, "apt Release.gpg")
        gpg.clearsigned(apt_release.with_name("InRelease"), apt_release, "apt InRelease")
        repomd = build / "repository/rpm/repodata/repomd.xml"
        gpg.detached(repomd.with_name("repomd.xml.asc"), repomd, "rpm repomd.xml")


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(description=__doc__)
    result.add_argument("--desktop-dir", required=True, type=Path)
    result.add_argument("--trust-policy", required=True, type=Path)
    result.add_argument("--trust-key", required=True, type=Path)
    result.add_argument("--gpg", type=Path)
    result.add_argument("--expected-fingerprint")
    result.add_argument("--expected-commit", required=True)
    result.add_argument("--expected-tree", required=True)
    result.add_argument("--expected-tag", required=True)
    result.add_argument("--expected-build-id", required=True)
    result.add_argument("--expected-build-number", required=True)
    result.add_argument("--expected-source-epoch", required=True)
    result.add_argument("--expected-app-id", required=True)
    result.add_argument("--expected-title", required=True)
    result.add_argument("--expected-version", required=True)
    result.add_argument("--expected-release", required=True)
    result.add_argument("--expected-app-build", required=True)
    return result


def main() -> int:
    try:
        verify(parser().parse_args())
    except (VerificationError, OSError, subprocess.SubprocessError) as error:
        print(f"verify-linux-release: {error}", file=sys.stderr)
        return 1
    print("verify-linux-release: pinned signatures, package copies, apt/rpm metadata and provenance passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
