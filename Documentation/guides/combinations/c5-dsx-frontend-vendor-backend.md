# C5: a DSX front end on your vendor's backend, directly

DSX does not require its own backend. A DSX app talks to Supabase, Firebase, or any HTTPS
API directly — the honest guide for teams whose backend is already decided.

## The shape

Declare the call where you use it — an `<api>` block is the front end's data contract:

```dsx
<stack>
  <head>
    <api as="rows" url="https://your-project.supabase.co/rest/v1/rows"
         headers="{ apikey: dsx.const.supabaseAnon }"/>
  </head>
  <list source="rows.data">
    <text value="{{ item.title }}"/>
  </list>
</stack>
```

- `rows.data`, `rows.loading`, `rows.error` are reactive; refetch follows the inputs the
  block reads (the `<api>` corpus pins the exact semantics on all three renderers — web,
  iOS, Android — so the same document behaves identically everywhere).
- Auth against a vendor: keep tokens in state/const planes and pass them as headers; an
  OAuth/OIDC flow that needs a system browser is a module action on the native surfaces.
- Writes: `<api>` blocks send with `rows.send({ … })`, or a declared `<action>` fetches
  imperatively — both run the same runner grammar.

## When the vendor needs privileged calls

A secret must never ship in a client. The moment a call needs a service key, that call is a
backend route — which is combination [C3](c3-existing-app-despia-backend.md) (a Despia
backend beside your app) or the vendor's own edge functions. C5 stays the no-secrets shape
by definition, and that line is the security boundary, not a styling choice.

## What CI proves, from tarballs

The matrix gate adds an `<api>` component against an external URL to the scaffolded app and
proves `dsx build` and `dsx lint --strict` stay green — the front-end-only claim, walked.
The runtime semantics of the block are separately corpus-gated
(`OpenSource/Conformance/api/`, three runtimes).
