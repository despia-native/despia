# Security policy

## Reporting a vulnerability

Do not open a public issue for anything you believe is a security problem.

Report privately, either way works:

- GitHub: **Security → Report a vulnerability** on `despia-native/despia` (private advisory).
- Email: **security@despia.com**.

Include what you can: the affected package and version, a reproduction or proof of concept,
and the impact as you understand it. You will get an acknowledgement within 72 hours and a
status update at least every 7 days until resolution.

## Supported versions

During `0.x`, security fixes land on the latest published minor of each package and ship as a
patch release. Older lines do not receive backports until `1.0`.

## Scope notes that save round trips

- The DSX kernel's JS tier is hardening for an app author's own code, not a boundary between
  tenants. Reports assuming it is a tenant sandbox will be answered with this paragraph.
- The server node evaluates authorization in the database as the requesting user (row-level
  security). Reports that a signed-in user can discover a table they cannot read rows from
  describe the accepted design, not a leak.
- Vendored dependencies (SQLite, ggml, llama.cpp, whisper.cpp, sqlite-vec) are pinned in each
  package's `vendor/VERSIONS`. Upstream CVEs in those pins are in scope; report them here too
  so we cut a patched release.

## Disclosure

We coordinate disclosure with the reporter and credit you in the release notes unless you ask
otherwise.
