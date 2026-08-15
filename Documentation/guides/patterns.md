# Common patterns

Real workflows that compose modules. Each uses the modern API; open the linked module READMEs
for full actions, params, and error codes.

## Scan a code, then navigate

```js
const { result } = await window.dsx.module.scanner();   // QRScanner
window.dsx.global.set("route.path", result);             // Routing — go to the scanned deep link
```

(`window.despia.navigate(path)` is the legacy alias for the `route.path` write.)

QRScanner rejects with `permission_denied` / `camera_unavailable`, so wrap it (see
[error handling](getting-started.md#handling-errors)).

## Unlock premium from a purchase

```js
const { entitlements } = await window.dsx.module.store.entitlements();   // Store
await window.dsx.global.set("premium", entitlements.includes("pro"));
```

Web and native screens both read `global.premium` reactively (e.g. a DSX
`visible-if="dsx.global.premium"`). One purchase, every surface updates.

## Upload an image and reuse it

```js
const file = input.files[0];
await window.dsx.module.cdn.upload({ bucket: "uploads", name: "avatar.jpg", file });
await window.dsx.global.set("profile.avatar", { bucket: "uploads", name: "avatar.jpg" });
```

Persist the `bucket/name` (not the URL) and re-resolve with `cdn.url` when you render — see
[files-and-storage](files-and-storage.md).

## Track location on a map

```js
const off = window.dsx.on("location", (e) => {        // Location streams via broadcast
  if (e.event === "change") drawPin(e.data.latitude, e.data.longitude);
});
await window.dsx.module.location({ buffer: 5, movement: 10 }); // start streaming
// when the map screen closes:
off();
```

A broadcast stream — remember the cleanup ([cleanup & lifecycle](state-and-events.md#cleanup--lifecycle)).

## Sign in, stash the token, share it app-wide

```js
// OAuth: the await is only an ack — it resolves { started: true } when the auth sheet
// opens. The REAL result arrives out-of-band, as a `result` broadcast on "oauth"
// (a user-paced login would outlive any promise timeout).
const off = window.dsx.on("oauth", async (e) => {
  if (e.event !== "result") return;              // cancel / provider errors arrive as "error"
  const { token, user } = e.data;                // the callback's params (query + fragment)
  await window.dsx.module.identityvault.write({ key: "auth", value: token });   // IdentityVault (optional biometric gate)
  await window.dsx.global.set("session.user", user);
  off();
});
const { started } = await window.dsx.module.oauth({ url: authorizeUrl });   // opens the sheet
```

The token lives in the vault; `global.session` drives the signed-in UI everywhere.

## React to shared state, and clean up

```js
const sub = window.dsx.global.watch("session.premium", (isPremium) => {
  render(isPremium ? premiumView() : freeView());
});
// on teardown:
sub.stop();
```

Every `watch` / `start` / `on` gets one `stop()` / `off()`.
