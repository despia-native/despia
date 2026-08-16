#!/usr/bin/env python3
from __future__ import annotations

import datetime as dt
import gzip
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest


MODULE_PATH = Path(__file__).with_name("verify-linux-release.py")
SPEC = importlib.util.spec_from_file_location("dsx_verify_linux_release", MODULE_PATH)
assert SPEC is not None and SPEC.loader is not None
VERIFIER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(VERIFIER)


class LinuxReleaseVerifierTest(unittest.TestCase):
    ROOT = Path(__file__).resolve().parents[5]
    TRUST_KEY = ROOT / "ClosedSource/release/linux-signing-public-key.asc"
    TRUST_POLICY = ROOT / "ClosedSource/release/linux-signing-trust.json"
    FINGERPRINT = "7DD5628FFA46A6C690E82B4DD44D2CB2A1D87494"

    def write(self, root: Path, relative: str, data: bytes | str) -> Path:
        path = root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        if isinstance(data, str):
            with path.open("w", encoding="utf-8", newline="\n") as handle:
                handle.write(data)
        else:
            path.write_bytes(data)
        return path

    def test_committed_trust_anchor_is_exact_active_and_digest_pinned(self) -> None:
        fingerprint, digest = VERIFIER.validate_trust_policy(
            self.TRUST_POLICY,
            self.TRUST_KEY,
            now=dt.datetime(2027, 1, 1, tzinfo=dt.timezone.utc),
        )
        self.assertEqual(self.FINGERPRINT, fingerprint)
        self.assertEqual(hashlib.sha256(self.TRUST_KEY.read_bytes()).hexdigest(), digest)

    def test_duplicate_expired_private_or_symlinked_trust_material_fails(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            key = self.write(root, "key.asc", self.TRUST_KEY.read_bytes())
            policy = json.loads(self.TRUST_POLICY.read_text(encoding="utf-8"))
            policy["publicKeySha256"] = hashlib.sha256(key.read_bytes()).hexdigest()
            candidate = self.write(root, "policy.json", json.dumps(policy))
            with self.assertRaisesRegex(VERIFIER.VerificationError, "validity window"):
                VERIFIER.validate_trust_policy(
                    candidate, key, now=dt.datetime(2030, 1, 1, tzinfo=dt.timezone.utc)
                )
            self.write(
                root,
                "duplicate.json",
                self.TRUST_POLICY.read_text(encoding="utf-8").replace(
                    '"status": "active",', '"status": "active",\n  "status": "active",'
                ),
            )
            with self.assertRaisesRegex(VERIFIER.VerificationError, "duplicate key"):
                VERIFIER.strict_json(root / "duplicate.json")
            self.write(root, "private.asc", "-----BEGIN PGP PRIVATE KEY BLOCK-----\n")
            policy["publicKeySha256"] = hashlib.sha256((root / "private.asc").read_bytes()).hexdigest()
            self.write(root, "private-policy.json", json.dumps(policy))
            with self.assertRaisesRegex(VERIFIER.VerificationError, "private-key material"):
                VERIFIER.validate_trust_policy(
                    root / "private-policy.json",
                    root / "private.asc",
                    now=dt.datetime(2027, 1, 1, tzinfo=dt.timezone.utc),
                )
            (root / "key-link.asc").symlink_to(key)
            with self.assertRaisesRegex(VERIFIER.VerificationError, "regular file"):
                VERIFIER.read_regular(root / "key-link.asc")

    def test_path_and_json_admission_attacks_fail_closed(self) -> None:
        for value in ("../evil", "/absolute", "a//b", "a/./b", "a\\b", ""):
            with self.subTest(value=value), self.assertRaises(VERIFIER.VerificationError):
                VERIFIER.canonical_relative(value)
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            malformed = self.write(root, "bad.json", '{"ok":NaN}\n')
            with self.assertRaises(VERIFIER.VerificationError):
                VERIFIER.strict_json(malformed)
            admission = {
                "ok": True,
                "mode": "checkout",
                "root": "/checkout",
                "head": "a" * 40,
                "tree": "b" * 40,
                "passes": [str(index) for index in range(9)],
                "failures": [],
            }
            path = self.write(root, "admission.json", json.dumps(admission))
            VERIFIER.validate_source_admission(path, "a" * 40, "b" * 40)
            admission["failures"] = ["dirty"]
            self.write(root, "admission.json", json.dumps(admission))
            with self.assertRaisesRegex(VERIFIER.VerificationError, "did not pass|does not match"):
                VERIFIER.validate_source_admission(path, "a" * 40, "b" * 40)

    def test_release_tree_rejects_symlinks_before_subject_or_signature_checks(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            tree = root / "repository"
            tree.mkdir()
            target = self.write(root, "outside/metadata", b"outside\n")
            (tree / "metadata").symlink_to(target)
            with self.assertRaisesRegex(VERIFIER.VerificationError, "symbolic link"):
                VERIFIER.reject_symlink_tree(tree)

    def test_public_repository_requires_exact_publishable_modes_and_regular_entries(self) -> None:
        def fixture(temporary: str) -> tuple[Path, Path, Path]:
            repository = Path(temporary) / "repository"
            metadata_dir = repository / "apt/dists/stable"
            metadata_dir.mkdir(parents=True)
            metadata = self.write(metadata_dir, "Release", "release\n")
            for directory in (repository, repository / "apt", repository / "apt/dists", metadata_dir):
                directory.chmod(0o755)
            metadata.chmod(0o644)
            return repository, metadata_dir, metadata

        with tempfile.TemporaryDirectory() as temporary:
            repository, _metadata_dir, _metadata = fixture(temporary)
            VERIFIER.validate_public_repository_tree(repository)

        mutations = (
            ("private root", lambda repository, _directory, _file: repository.chmod(0o700), "0755"),
            ("writable directory", lambda _repository, directory, _file: directory.chmod(0o777), "0755"),
            ("private file", lambda _repository, _directory, file: file.chmod(0o600), "0644"),
            ("executable file", lambda _repository, _directory, file: file.chmod(0o755), "0644"),
        )
        for label, mutate, message in mutations:
            with self.subTest(label=label), tempfile.TemporaryDirectory() as temporary:
                repository, metadata_dir, metadata = fixture(temporary)
                mutate(repository, metadata_dir, metadata)
                with self.assertRaisesRegex(VERIFIER.VerificationError, message):
                    VERIFIER.validate_public_repository_tree(repository)

        with tempfile.TemporaryDirectory() as temporary:
            repository, metadata_dir, metadata = fixture(temporary)
            (metadata_dir / "Release.link").symlink_to(metadata)
            with self.assertRaisesRegex(VERIFIER.VerificationError, "symbolic link"):
                VERIFIER.validate_public_repository_tree(repository)

        if hasattr(os, "mkfifo"):
            with tempfile.TemporaryDirectory() as temporary:
                repository, metadata_dir, _metadata = fixture(temporary)
                os.mkfifo(metadata_dir / "unexpected.fifo", 0o644)
                with self.assertRaisesRegex(VERIFIER.VerificationError, "special filesystem entry"):
                    VERIFIER.validate_public_repository_tree(repository)

    def make_apt(self, root: Path, *, filename: str | None = None) -> tuple[Path, Path]:
        source_deb = self.write(root, "source/app.deb", b"deb-package\n")
        apt = root / "apt"
        pool = self.write(apt, "pool/main/d/dev.dsx.runtime/app.deb", source_deb.read_bytes())
        package_name = filename or "pool/main/d/dev.dsx.runtime/app.deb"
        packages_text = (
            "Package: dev.dsx.runtime\n"
            "Version: 1.2.3-1\n"
            "Architecture: amd64\n"
            f"Filename: {package_name}\n"
            f"Size: {pool.stat().st_size}\n"
            f"SHA256: {VERIFIER.sha256_file(pool)}\n"
        )
        packages = self.write(apt, "dists/stable/main/binary-amd64/Packages", packages_text)
        packages_gz = self.write(
            apt,
            "dists/stable/main/binary-amd64/Packages.gz",
            gzip.compress(packages.read_bytes(), mtime=0),
        )
        for path in (packages, packages_gz):
            self.write(
                apt,
                "dists/stable/main/binary-amd64/by-hash/SHA256/" + VERIFIER.sha256_file(path),
                path.read_bytes(),
            )
        records = []
        for path in (packages, packages_gz):
            relative = path.relative_to(apt / "dists/stable").as_posix()
            records.append(f" {VERIFIER.sha256_file(path)} {path.stat().st_size} {relative}")
        self.write(
            apt,
            "dists/stable/Release",
            "Origin: DSX\nLabel: DSX\nSuite: stable\nCodename: stable\n"
            "Date: Thu, 01 Jan 2026 00:00:00 GMT\nArchitectures: amd64\nComponents: main\n"
            "Acquire-By-Hash: yes\nDescription: DSX\nSHA256:\n" + "\n".join(records) + "\n",
        )
        return apt, source_deb

    def test_apt_repository_binds_one_package_and_rejects_traversal_or_tampering(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            apt, source = self.make_apt(root)
            files = VERIFIER.validate_apt_repository(apt, source, "dev.dsx.runtime", "1.2.3", "1")
            self.assertEqual(6, len(files))
            packages = apt / "dists/stable/main/binary-amd64/Packages"
            packages.write_text(packages.read_text().replace("pool/main/", "../"), encoding="utf-8")
            with self.assertRaises(VERIFIER.VerificationError):
                VERIFIER.validate_apt_repository(apt, source, "dev.dsx.runtime", "1.2.3", "1")
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            apt, source = self.make_apt(root)
            (apt / "dists/stable/main/binary-amd64/Packages.gz").write_bytes(b"tampered")
            with self.assertRaisesRegex(VERIFIER.VerificationError, "Packages.gz"):
                VERIFIER.validate_apt_repository(apt, source, "dev.dsx.runtime", "1.2.3", "1")

    def make_rpm(self, root: Path, *, href: str = "repodata/primary.xml.gz") -> tuple[Path, Path]:
        source = self.write(root, "source/app.rpm", b"rpm-package\n")
        rpm = root / "rpm"
        repository_rpm = self.write(rpm, "x86_64/app.rpm", source.read_bytes())
        metadata = {}
        for kind in ("primary", "filelists", "other"):
            if kind == "primary":
                contents = (
                    '<metadata xmlns="http://linux.duke.edu/metadata/common" packages="1">'
                    '<package type="rpm"><name>dev.dsx.runtime</name><arch>x86_64</arch>'
                    '<version epoch="0" ver="1.2.3" rel="1"/>'
                    f'<checksum type="sha256" pkgid="YES">{VERIFIER.sha256_file(repository_rpm)}</checksum>'
                    '<location href="x86_64/app.rpm"/>'
                    f'<size package="{repository_rpm.stat().st_size}" installed="1" archive="1"/>'
                    '</package></metadata>'
                ).encode()
            else:
                contents = f"<{kind}/>\n".encode()
            path = self.write(rpm, f"repodata/{kind}.xml.gz", gzip.compress(contents, mtime=0))
            metadata[kind] = path
        namespace = "http://linux.duke.edu/metadata/repo"
        chunks = [f'<repomd xmlns="{namespace}"><revision>1767225600</revision>']
        for kind, path in metadata.items():
            location = href if kind == "primary" else f"repodata/{kind}.xml.gz"
            chunks.append(
                f'<data type="{kind}"><checksum type="sha256">{VERIFIER.sha256_file(path)}</checksum>'
                f'<location href="{location}"/><size>{path.stat().st_size}</size></data>'
            )
        chunks.append("</repomd>")
        self.write(rpm, "repodata/repomd.xml", "".join(chunks))
        return rpm, source

    def test_rpm_repository_rejects_metadata_traversal_dtd_and_digest_tampering(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            rpm, source = self.make_rpm(root)
            files = VERIFIER.validate_rpm_repository(
                rpm, source, "dev.dsx.runtime", "1.2.3", "1", "1767225600"
            )
            self.assertEqual(5, len(files))
            repomd = rpm / "repodata/repomd.xml"
            repomd.write_text(repomd.read_text().replace("repodata/primary", "../primary"), encoding="utf-8")
            with self.assertRaises(VERIFIER.VerificationError):
                VERIFIER.validate_rpm_repository(
                    rpm, source, "dev.dsx.runtime", "1.2.3", "1", "1767225600"
                )
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            rpm, source = self.make_rpm(root)
            repomd = rpm / "repodata/repomd.xml"
            repomd.write_text("<!DOCTYPE x [<!ENTITY e SYSTEM 'file:///etc/passwd'>]>" + repomd.read_text())
            with self.assertRaisesRegex(VERIFIER.VerificationError, "DTD/entity"):
                VERIFIER.validate_rpm_repository(
                    rpm, source, "dev.dsx.runtime", "1.2.3", "1", "1767225600"
                )
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            rpm, source = self.make_rpm(root)
            (rpm / "repodata/other.xml.gz").write_bytes(b"tampered")
            with self.assertRaisesRegex(VERIFIER.VerificationError, "does not bind"):
                VERIFIER.validate_rpm_repository(
                    rpm, source, "dev.dsx.runtime", "1.2.3", "1", "1767225600"
                )

    def test_openpgp_status_requires_one_sha256_signature_from_pinned_primary(self) -> None:
        verifier = VERIFIER.GpgVerifier(Path("/usr/bin/true"), self.TRUST_KEY, self.FINGERPRINT)
        valid = (
            f"[GNUPG:] VALIDSIG {self.FINGERPRINT} 2026-01-01 1 0 4 0 1 8 00 {self.FINGERPRINT}\n"
        ).encode()
        verifier._validate_status(valid, "fixture")
        with self.assertRaisesRegex(VERIFIER.VerificationError, "SHA-256"):
            verifier._validate_status(valid.replace(b" 8 00 ", b" 10 00 "), "fixture")
        with self.assertRaisesRegex(VERIFIER.VerificationError, "invalid OpenPGP status"):
            verifier._validate_status(b"[GNUPG:] REVKEYSIG bad\n" + valid, "fixture")
        with self.assertRaisesRegex(VERIFIER.VerificationError, "exactly one"):
            verifier._validate_status(valid + valid, "fixture")
        bounded = VERIFIER.GpgVerifier(
            Path("/usr/bin/true"),
            self.TRUST_KEY,
            self.FINGERPRINT,
            minimum_signature_epoch=2,
        )
        with self.assertRaisesRegex(VERIFIER.VerificationError, "predates"):
            bounded._validate_status(valid, "fixture")


if __name__ == "__main__":
    unittest.main()
