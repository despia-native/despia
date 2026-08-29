# Self-hosted CI/CD — a Mac mini as a Despia build node

One command turns a Mac mini into a Despia build machine that runs the **same lanes** as
the hosted pipeline (the yaml's app workflows, extracted verbatim — never forked), driven
by the **same per-app config folder** ([codemagic-build.md](codemagic-build.md) — no YAML,
no per-app pipeline). The node exposes an HTTP API on loopback, keeps a persistent build
queue, pushes HMAC-signed status webhooks to any backend, and — when a build request asks
— submits to TestFlight / Google Play after re-verifying the artifact digest against its
attestation.

Architecture law: `OpenSource/Documentation/architecture/proposals/despia-cicd.md` ·
API spec: `ClosedSource/Documentation/despia-cicd-node-api.md` ·
fleet integration: `ClosedSource/CICD/docs/fleet-protocol.md`.

## 1. Install (one command)

On a dedicated CI user (auto-login recommended — simulators and the keychain want a GUI
session):

```bash
# from a checkout
bash ClosedSource/CICD/install/install.sh

# or bootstrap from nothing (SSH deploy key recommended; tokens are never embedded)
DESPIA_REPO_URL=git@github.com:despia-native/despia-framework.git \
  bash -c "$(curl -fsSL https://<your-host>/install.sh)"
```

The installer clones/locates the framework, creates `~/despia-cicd` (override:
`DESPIA_CICD_HOME`), mints the vault master key into the login Keychain, registers a
launchd LaunchAgent (`KeepAlive` — the queue survives reboots), and runs the doctor.

```bash
despia-cicd doctor          # every lane pin, with its exact fix
despia-cicd doctor --fix    # safe user-space fixes only (pip/gem at exact pins)

# then prove the node actually works, on this machine, in ~3 minutes:
ruby ClosedSource/CICD/tools/verify_local.rb    # expect 14/14
```

`verify_local.rb` boots the real daemon against a throwaway fixture repo and
walks the whole chain — queue, build, step wrapper, signed webhooks, artifacts,
metrics, quotas, cancel, crash recovery, secret rotation — then prints what it
could **not** prove on this host. Run it after install and after every upgrade.

Xcode 26.6, JDK 21, and the Android SDK packages are deliberate manual installs — the
doctor prints the exact commands. A Mac without an Android SDK simply never takes
`android-app` builds (capabilities ride `GET /v1/status`).

## 2. Provision credentials

Two sources, same laws as the hosted pipeline; request variables never carry durable
secrets.

```bash
# The vault — the credential-group equivalent (AES-256-GCM, key in the login Keychain).
despia-cicd secrets set APP_STORE_CONNECT_KEY_IDENTIFIER   < key-id.txt
despia-cicd secrets set APP_STORE_CONNECT_ISSUER_ID        < issuer.txt
despia-cicd secrets set APP_STORE_CONNECT_PRIVATE_KEY      < AuthKey.p8
despia-cicd secrets set CERTIFICATE_PRIVATE_KEY            < dist-cert-key.pem
despia-cicd secrets set ANDROID_KEYSTORE_B64               < keystore.b64
despia-cicd secrets set CM_KEYSTORE_PASSWORD               < store-pass.txt
# per-client scope wins over global; publish creds are per-client by convention:
despia-cicd secrets set GCLOUD_SERVICE_ACCOUNT_CREDENTIALS --client acme-demo < svc.json
```

Or keep the **signing broker** flow: pass `SIGNING_URL` + short-lived `SIGNING_TOKEN` per
build — `fetch_signing_material.sh` runs unchanged, including its committed fail-closed
host allowlist. Values are only ever process env; never argv, never logs (a redactor
scrubs every sink), never webhook payloads.

## 3. Connect your backend (tap-free status)

```bash
despia-cicd token new --role trigger --label backend      # POST builds + cancel
despia-cicd token new --role status  --label dashboard    # read-only
echo "$WEBHOOK_SECRET" | despia-cicd webhooks add --url https://backend.example/hooks
despia-cicd webhooks test <id>                            # signed node.status, on demand
```

Every build pushes `build.queued|started|step|succeeded|failed|canceled|timeout`; the node
heartbeats `node.status` (queue depth, running step, capabilities, toolchain pins, disk)
every minute and on every transition — your backend load-balances a whole fleet without
polling. Verify `X-Despia-Signature` (HMAC-SHA256, ±300 s window) — recipe + reference
code in the fleet doc.

## 4. Trigger builds

```bash
# HTTP (loopback; remote = SSH tunnel or the opt-in TLS LAN listener in config.json)
curl -s -X POST http://127.0.0.1:8787/v1/builds \
  -H "Authorization: Bearer $TRIGGER_TOKEN" -H 'Content-Type: application/json' \
  -d '{
    "workflowId": "ios-app",
    "tag": "release/acme-demo-42",
    "requestId": "'"$(uuidgen)"'",
    "environment": { "variables": {
      "CLIENT_ID": "acme-demo",
      "CLIENT_ASSEST_URL": "https://cdn.example.com/builds/acme-demo.zip",
      "CLIENT_ASSETS_SHA256": "<64-hex>" } },
    "publish": { "target": "testflight" }
  }'

# or over SSH, no ports at all
ssh ci@mac-01 despia-cicd build --workflow android-app --tag release/acme-demo-42 \
  --var CLIENT_ID=acme-demo --publish play --track internal --draft
```

The `tag` is required: app lanes admit a pushed tag and build exactly `tag^{commit}` —
the same provenance law the hosted lanes enforce. Watch progress with
`despia-cicd show <buildId>` / `logs` / `artifacts`, or just consume the webhooks.

## 5. Operate

```bash
despia-cicd status              # the fleet-balancing payload, locally
despia-cicd metrics             # counters + gauges (--format prometheus for scraping)
despia-cicd builds --status queued
despia-cicd cancel <buildId>
despia-cicd update              # ff-only pull of the node checkout + daemon restart
bash ClosedSource/CICD/install/uninstall.sh [--purge]
```

Back up the vault and rotate its key without downtime:

```bash
despia-cicd secrets export --out backup.json --apply   # passphrase on stdin; portable
despia-cicd secrets rotate-key --apply                 # re-encrypt under a new key
despia-cicd secrets rotate-key --prune <oldKeyId> --apply   # after verifying a build
```

Every mutating `secrets` verb plans by default; passphrases come from stdin or a
0600 `--passphrase-file`, never from the command line.

Artifacts stay on the node (GC by age/size, disk visible in `/v1/status`) and can also be
pushed to presigned URLs per build (`artifacts.upload`). Console logs are admin-token
only. One build runs at a time per node by design (`$CM_ENV` is a per-user singleton) —
add minis to add capacity; the fleet doc shows the dispatch loop.

## 6. What stays true from the hosted pipeline

- The **config folder is the build definition** — same zip, same `App.json` contract,
  same intake validation (`import_client_assets.py`), same module system.
- **Steps never send telemetry**; the daemon tails their local status records and does
  all the talking — `run_step.sh` and its guards are untouched.
- **Publishing is a bound handoff**: request-gated, digest-re-verified against the
  attestation, credentials scoped to the publish step only.
- **Codemagic keeps working** as the legacy twin: the lanes are extracted from
  `codemagic.yaml` and a CI parity gate (`extract_lanes.rb --check`) fails any silent
  divergence.

## 7. Where to look next

| Doc | For |
|---|---|
| `ClosedSource/CICD/docs/configuration.md` | every `config.json` knob, default and range |
| `ClosedSource/CICD/docs/operations.md` | monitoring, alerts, backup/restore, upgrades, decommissioning |
| `ClosedSource/CICD/docs/troubleshooting.md` | symptom → cause → fix |
| `ClosedSource/CICD/docs/security-model.md` | threat model, trust boundaries, secret lifecycle |
| `ClosedSource/Documentation/despia-cicd-node-api.md` | the HTTP + webhook contract |
| `ClosedSource/CICD/docs/fleet-protocol.md` | integrating a load-balancing backend |
| `ClosedSource/CICD/docs/internals.md` | changing the component itself |

Before enrolling a node in production, run the real-Mac checklist:
`ClosedSource/CICD/docs/mac-validation-runbook.md`.
