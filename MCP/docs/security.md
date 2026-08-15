# The threat model, stated plainly

One sentence carries this document: **on-device loopback is reachable by every
co-resident app, so the token is the boundary, not the interface.**

A local MCP server is a remote-code-execution surface wearing a friendly name.
It accepts a tool name and an argument bag and executes app behaviour. Every
decision below follows from taking that seriously.

## 1. The bind address

The listener binds numeric `127.0.0.1` (and `::1` where a dual-stack listener is
used). Not a hostname - a hostname resolves, and a resolver is an input. Not a
wildcard - a wildcard makes a phone's MCP server reachable from the café's Wi-Fi.

There is no host configuration key. The address is a constant in one place per
lane, and a test binds the real socket, reads back the bound address, and fails
if it is anything else. Regressing this fails a gate, not a review.

The port is OS-selected and ephemeral. That is a nuisance for static agent-host
configs, which is what the discovery file (§4) exists to solve; it is not
negotiable, because a fixed port is a fixed target.

## 2. The session token

Every request must carry the current session token in an `Authorization: Bearer`
header. The token is 256 bits from the platform CSPRNG, minted fresh at each
`start()`, and compared in constant time.

Three properties, each deliberate:

- **It never appears in a URL.** Not in a path, not in a query string. URLs land
  in history, in referrers, in crash logs and in screenshots. The header is the
  only place it travels.
- **Missing and wrong are the same answer.** Both get `unauthorized` with no
  detail. An error that distinguishes them is an oracle.
- **It does not persist across a restart.** A token that outlives the process
  that minted it is a credential with no expiry story.

Origin and Host are validated too - a browser on the device could otherwise be
steered into the loopback origin by a hostile page. But origin checks are a
defence against browsers, not against co-resident apps, which send whatever
headers they like. Only the token stops those.

## 3. What the server will execute

Only rows the app **declared**. The served tool list is derived from `facets.mcp`
declarations at build time; there is no dynamic registration path and no
"execute this action name" endpoint. A tool name that is not in the derived
table is `unknown_tool`, whether or not the caller is authenticated.

A row that declares `mutates` is approval-gated:

- the approval is requested BEFORE the tool executes, never after;
- a snapshot is taken before the write, so the state that existed beforehand is
  recoverable;
- **absence of an approver is a refusal, not a bypass.** If nothing in the app
  answers the approval claim, the call fails `approval_unavailable` and nothing
  is written. This is the direction a security default has to fail.

The protocol changes none of this. A write requested over MCP takes the same
path as a write requested by the in-app agent loop, which is the entire point of
deriving both from one declaration.

## 4. External pairing, and why it is a separate token

A desktop agent host has a static config file and cannot know an ephemeral port
or a per-session token. It reads a **discovery file** in the app container:

```json
{ "port": 51234, "token": "…", "protocol": "2025-11-25", "pid": 4711 }
```

Four rules govern it.

- **Mode 0600.** Owner read/write only. A discovery file another user can read
  is the token, published.
- **Its token is NOT the session token.** It is a distinct pairing token. An
  external host that is later revoked must not hold a credential the app's own
  surfaces are still using.
- **It exists only while consent stands.** Granting external access writes it;
  withdrawing removes it AND rotates the pairing token, so a host that cached
  the old value is refused on its next request. Withdrawal that only deleted a
  file would be theatre.
- **The stdio launcher carries no secret.** The launcher a host references
  statically reads the discovery file at run time and proxies stdio to the
  loopback port. It never embeds a token, because a launcher script is exactly
  the kind of file people paste into an issue.

## 5. Resource bounds

The framing runs on this package's own listener rather than an HTTP server
framework, so its limits are visible and small: capped header size and count,
capped body, capped concurrent connections, a bounded worker pool, and separate
deadlines for the header phase, the body phase and the response. A hostile
request is bounded by construction rather than by a framework's defaults.

Those limits mirror the ones the Despia content server already ships, for the
plain reason that they were already argued once.

## 6. What this package does NOT defend against

Stated so nobody has to infer it.

- **A compromised app process.** Anything running in the app can call the tools
  directly; the server is not a sandbox around the app.
- **A user who approves a hostile write.** Approval is a human decision. The
  guarantee is that the decision happens before the write and that the prior
  state is snapshotted, not that the decision is correct.
- **A malicious declared server's tool descriptions.** Descriptions are
  untrusted text; they ride to the model tagged with their provenance and change
  no policy. They can still say misleading things to a model, which is why
  `mutates` gating is a property of the ROW and not of the description.
- **Traffic analysis of the loopback socket by a co-resident app.** The
  transport is plain HTTP on loopback. TLS on 127.0.0.1 would need a trusted
  local certificate, which is its own, larger, worse problem.
