#!/usr/bin/env python3
"""Download and digest-verify the permissive dictionaries a G2P pack is built from.

This is the first step of the offline pack pipeline described in
``OpenSource/AI/docs/g2p-pack.md``.  Nothing here ships; the artifact it produces
is a work directory that ``train_lts.py`` and ``build_pack.py`` read.

Every source is pinned by sha256.  A mismatch aborts, because the alternative is a
pack whose ``META.sources`` records a licence and a digest that describe some other
bytes than the ones that were actually baked in.  The wheel is additionally checked
member by member against its own ``RECORD``, so a corrupted extraction is caught
before a lexicon with one flipped byte reaches the trainer.

The tool writes ``sources.json`` next to the extracted files.  That file is the only
thing downstream tools read about provenance, and it is what ends up in
``META.sources`` where ``ai_package_gate.rb`` can see it.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import io
import json
import os
import sys
import tempfile
import urllib.error
import urllib.request
import zipfile
from pathlib import Path
from typing import Dict, List, Optional


USER_AGENT = "despia-g2p-fetch/1"
NETWORK_TIMEOUT_S = 300

# The two tiers, in the order a lookup would consult them.  Tier 1 is the alphabet
# the pack is written in, so it is required.  Tier 2 is a second opinion in a
# different phone set and is therefore optional; see the note in ``report()``.
MISAKI = {
    "key": "misaki",
    "name": "misaki 0.9.4 (us_gold.json, us_silver.json)",
    "spdx": "Apache-2.0",
    "url": "https://files.pythonhosted.org/packages/py3/m/misaki/misaki-0.9.4-py3-none-any.whl",
    "sha256": "90e2eeb169786c014c429e5058d2ea6bcd02d651f2a24450ba6c9ffc0f8da15a",
    "archive": "misaki-0.9.4-py3-none-any.whl",
    "required": True,
    # Wheel members to extract, mapped to their name in the work directory.
    "members": {
        "misaki/data/us_gold.json": "us_gold.json",
        "misaki/data/us_silver.json": "us_silver.json",
        "misaki-0.9.4.dist-info/licenses/LICENSE": "misaki-LICENSE.txt",
    },
    "record": "misaki-0.9.4.dist-info/RECORD",
}

# Pinned to a commit rather than to ``master``, because a branch name names
# different bytes on different days and a digest pinned to one is a digest that
# will start failing for no reason a reader can see.
CMUDICT_COMMIT = "74790861f652b15e4ac49015a90074ad62a27690"
CMUDICT = {
    "key": "cmudict",
    "name": "CMU Pronouncing Dictionary (cmudict.dict @ %s)" % CMUDICT_COMMIT[:12],
    "spdx": "BSD-2-Clause",
    "url": "https://raw.githubusercontent.com/cmusphinx/cmudict/%s/cmudict.dict" % CMUDICT_COMMIT,
    "sha256": "81917843c7f44ce2b094ac63873c2c7a4cf802040792c455ba3ca406891c3d22",
    "archive": "cmudict.dict",
    "required": False,
    "extra": {
        "url": "https://raw.githubusercontent.com/cmusphinx/cmudict/%s/LICENSE" % CMUDICT_COMMIT,
        "sha256": "bd4ce8e44170a5f9f481310ca85c51de3c4f851a65e679b40e603b143bd3542a",
        "name": "cmudict-LICENSE.txt",
    },
}


class FetchError(RuntimeError):
    """A failure that must stop the build rather than degrade it silently."""


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def record_digest(field: str) -> str:
    """Turn a wheel RECORD ``sha256=<urlsafe-b64>`` field into a hex digest."""
    if not field.startswith("sha256="):
        raise FetchError("RECORD entry is not sha256: %r" % field)
    raw = field[len("sha256="):]
    pad = "=" * (-len(raw) % 4)
    return base64.urlsafe_b64decode(raw + pad).hex()


def download(url: str, timeout: int = NETWORK_TIMEOUT_S) -> bytes:
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return response.read()
    except (urllib.error.URLError, OSError) as exc:  # noqa: PERF203 - one message per cause
        raise FetchError("could not fetch %s: %s" % (url, exc)) from exc


def fetch_verified(url: str, expected: str, cache: Path, timeout: int) -> bytes:
    """Return the bytes at ``url``, reusing ``cache`` when it already matches.

    The digest is checked on the cached copy too.  A cache that is trusted because
    it exists is a cache that will one day hand the build a truncated file.
    """
    if cache.is_file():
        data = cache.read_bytes()
        got = sha256_bytes(data)
        if got == expected:
            print("  cached  %s (%d B)" % (cache.name, len(data)))
            return data
        print("  cache digest mismatch for %s, refetching" % cache.name, file=sys.stderr)
    data = download(url, timeout)
    got = sha256_bytes(data)
    if got != expected:
        raise FetchError(
            "digest mismatch for %s\n  expected %s\n  got      %s" % (url, expected, got)
        )
    write_atomic(cache, data)
    print("  fetched %s (%d B) sha256 ok" % (cache.name, len(data)))
    return data


def write_atomic(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    handle, tmp = tempfile.mkstemp(dir=str(path.parent), prefix=".tmp-")
    try:
        with os.fdopen(handle, "wb") as out:
            out.write(data)
        os.chmod(tmp, 0o644)
        os.replace(tmp, path)
    except BaseException:
        if os.path.exists(tmp):
            os.unlink(tmp)
        raise


def extract_wheel(data: bytes, spec: Dict, work: Path) -> List[Dict]:
    """Extract the pinned members and cross-check each against the wheel RECORD."""
    files: List[Dict] = []
    with zipfile.ZipFile(io.BytesIO(data)) as zf:
        declared: Dict[str, str] = {}
        with zf.open(spec["record"]) as record:
            for line in io.TextIOWrapper(record, encoding="utf-8"):
                parts = line.rstrip("\r\n").split(",")
                if len(parts) == 3 and parts[1]:
                    declared[parts[0]] = parts[1]
        for member, name in sorted(spec["members"].items()):
            payload = zf.read(member)
            got = sha256_bytes(payload)
            if member in declared:
                want = record_digest(declared[member])
                if want != got:
                    raise FetchError(
                        "wheel member %s does not match RECORD\n  expected %s\n  got      %s"
                        % (member, want, got)
                    )
            else:
                raise FetchError("wheel member %s is absent from RECORD" % member)
            write_atomic(work / name, payload)
            files.append({"name": name, "member": member, "bytes": len(payload), "sha256": got})
            print("    member %s -> %s (%d B) RECORD ok" % (member, name, len(payload)))
    return files


def fetch_misaki(work: Path, cache: Path, timeout: int) -> Dict:
    print("misaki 0.9.4 - licence Apache-2.0")
    data = fetch_verified(MISAKI["url"], MISAKI["sha256"], cache / MISAKI["archive"], timeout)
    files = extract_wheel(data, MISAKI, work)
    return {
        "key": MISAKI["key"],
        "name": MISAKI["name"],
        "spdx": MISAKI["spdx"],
        "url": MISAKI["url"],
        "sha256": MISAKI["sha256"],
        "bytes": len(data),
        "files": files,
    }


def fetch_cmudict(work: Path, cache: Path, timeout: int) -> Optional[Dict]:
    """Fetch the optional second tier.  A network failure degrades, a digest does not.

    The distinction matters: an unreachable optional source is a pack built from tier
    one only, which is a stated, smaller pack.  A source that arrives with the wrong
    digest is an unknown input, and there is no safe way to continue from that.
    """
    print("cmudict @ %s - licence BSD-2-Clause" % CMUDICT_COMMIT[:12])
    try:
        data = fetch_verified(CMUDICT["url"], CMUDICT["sha256"], cache / CMUDICT["archive"], timeout)
        extra = CMUDICT["extra"]
        licence = fetch_verified(extra["url"], extra["sha256"], cache / extra["name"], timeout)
    except FetchError as exc:
        message = str(exc)
        if "digest mismatch" in message:
            raise
        print("  skipped: %s" % message, file=sys.stderr)
        return None
    write_atomic(work / "cmudict.dict", data)
    write_atomic(work / extra["name"], licence)
    return {
        "key": CMUDICT["key"],
        "name": CMUDICT["name"],
        "spdx": CMUDICT["spdx"],
        "url": CMUDICT["url"],
        "sha256": CMUDICT["sha256"],
        "bytes": len(data),
        "files": [
            {"name": "cmudict.dict", "bytes": len(data), "sha256": sha256_bytes(data)},
            {"name": extra["name"], "bytes": len(licence), "sha256": sha256_bytes(licence)},
        ],
        # The pack is written in misaki's phone alphabet.  cmudict is ARPABET, and
        # joining them needs a phone-set mapping table, which g2p-pack.md rules out
        # by name as the place a hand-ported frontend goes wrong.  So this tier is
        # fetched, verified and recorded, and build_pack.py does not consume it.
        "consumed_by_pack": False,
        "reason": "ARPABET phone set; merging would require a phone-set mapping table",
    }


def report(manifest: Dict) -> None:
    print()
    print("sources recorded in %s" % manifest["path"])
    for source in manifest["sources"]:
        used = "used" if source.get("consumed_by_pack", True) else "fetched, not used"
        print("  %-12s %-14s %s  [%s]" % (source["key"], source["spdx"], source["sha256"][:16], used))


def main(argv: List[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument(
        "--work-dir",
        default="/tmp/g2p/sources",
        help="where the verified files land (default: %(default)s, never inside the repo)",
    )
    parser.add_argument(
        "--cache-dir",
        default=None,
        help="where downloads are cached (default: <work-dir>/.cache)",
    )
    parser.add_argument("--no-cmudict", action="store_true", help="skip the optional second tier")
    parser.add_argument("--timeout", type=int, default=NETWORK_TIMEOUT_S)
    args = parser.parse_args(argv)

    work = Path(args.work_dir)
    cache = Path(args.cache_dir) if args.cache_dir else work / ".cache"
    work.mkdir(parents=True, exist_ok=True)
    cache.mkdir(parents=True, exist_ok=True)

    sources: List[Dict] = []
    try:
        sources.append(fetch_misaki(work, cache, args.timeout))
        if not args.no_cmudict:
            entry = fetch_cmudict(work, cache, args.timeout)
            if entry is not None:
                sources.append(entry)
    except FetchError as exc:
        print("fetch_sources: %s" % exc, file=sys.stderr)
        return 1

    manifest = {
        "schema": 1,
        "sources": sorted(sources, key=lambda s: s["key"]),
        "path": str(work / "sources.json"),
    }
    payload = json.dumps(
        {"schema": manifest["schema"], "sources": manifest["sources"]},
        ensure_ascii=False,
        indent=2,
        sort_keys=True,
    )
    write_atomic(work / "sources.json", payload.encode("utf-8") + b"\n")
    report(manifest)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
