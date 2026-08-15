# Cookies — `dsx.cookie`

> Audience: app authors. One cookie jar shared across the **web layer**, **native HTTP**, and
> **DSX markup** — as close to JavaScript's `document.cookie` as the platform allows, but typed
> and reactive.

The web layer (the DSX DOM / `WKWebView`) is the **source of truth**. When it sets a cookie —
a login response, a session token — DSX does two things automatically:

1. **Mirrors it to the native HTTP stack** (`HTTPCookieStorage.shared`), so a native
   `await fetch(…)` / `fetch:` request **sends it automatically**. Auth survives the
   web → native boundary with zero plumbing.
2. **Publishes it to DSX**, where markup reads it reactively.

## Read it from markup

```xml
<!-- one cookie by name -->
<text>Signed in as {{ dsx.cookie.user }}</text>
<vstack visible-if="dsx.cookie.session">…authenticated UI…</vstack>

<!-- the whole jar: { name: value, … } -->
<text>{{ len(dsx.cookie) }} cookies</text>
```

`dsx.cookie.<name>` is a single value (a string, or empty if absent); `dsx.cookie` is the whole jar as
an object. Both are **reactive** — when the web layer changes a cookie, every `{{ dsx.cookie.* }}`
re-evaluates and the UI updates, exactly like any other state.

## Use it in a request

You usually don't need to — native `fetch` already carries the mirrored cookies. But you can
read one explicitly when an API wants it in a header:

```xml
<action as="sync">
  const r = await fetch('/me', { headers: { Authorization: 'Bearer ' + dsx.cookie.token } })
  if (r.ok) dsx.variable.me = r.data
</action>
```

## Set it

Assign to set a cookie — JS-style (`document.cookie = …`, but typed). It's written to **both**
the web layer (so the page sees it) and the native HTTP stack (so `fetch` sends it):

```xml
<action as="login">
  const r = await fetch('/login', { method: 'POST', body: { email, password } })
  if (r.ok) {
    dsx.cookie.token_name = r.data.token     // → set across web + native, reactive
    dsx.module.route.replace({ path: '/home' })
  }
</action>
```

The cookie's **domain** defaults to the web app's host, **path** to `/`, and it's a session
cookie. Native code can pass more: `DSXCookies.shared.set("token_name", value, domain:, path:,
expires:)`.

## Notes

- **Which store.** The Dom module binds its own cookie observer to the web view it
  constructs (`cookieObserver.bind(to:)` in `DomWebHost.swift`) — the kernel holds no
  `WKWebView`, so `DSXCookies`' surface is only `setDomainHint`/`ingest` (+ the `jar` read).
- **Native code** reads the same jar via `HTTPCookieStorage.shared` (or `DSXCookies.shared.jar`).
