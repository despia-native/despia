# The combination matrix: every integration shape, named and walked

> Despia composes with what you already have. This index names every supported combination,
> and every row here is **a walked path, not prose**: the layouts below build in CI from the
> packed npm tarballs on every pull request (`OpenSource/Web/scripts/verify-combinations.ts`
> — the cold-start law extended to the whole matrix). What the toolchain reserves inside
> your repo is one short contract: [`../reserved-directories.md`](../reserved-directories.md).

| # | You have | You add | Guide |
|---|---|---|---|
| C1 | nothing yet | a pure DSX app: native iOS + native Android + installable PWA + SSR site from ONE codebase | [c1-pure-dsx-app.md](c1-pure-dsx-app.md) |
| C2 | a web app you keep | DSX **native** components/modules beside it; your pages reach them over `window.dsx` | [c2-web-app-plus-native.md](c2-web-app-plus-native.md) |
| C3 | a React/Vite/Next app you keep | a **Despia backend only** — routes, workers, MCP tools — served beside your app | [c3-existing-app-despia-backend.md](c3-existing-app-despia-backend.md) |
| C4 | nothing yet | DSX front end + Despia backend (the full stack) | C1's layout + [writing-a-backend](../../../Skills/writing-a-backend.md) — one repo, both halves |
| C5 | a Supabase/Firebase/any-HTTPS backend | a DSX front end talking to it **directly** — no Despia server anywhere | [c5-dsx-frontend-vendor-backend.md](c5-dsx-frontend-vendor-backend.md) |
| C6 | Convex or another vendor SDK | a third `RepoQuery` transport behind the frozen seam — the documented **extension point**, demand-driven, not shipped | (extension point; see `architecture/proposals/full-stack.md`) |
| C7 | any static host | **self-hosted OTA** for your app's content — no Despia hosting involved | [c7-self-hosted-ota.md](c7-self-hosted-ota.md) |

Two honest boundaries, stated once:

- **Native builds ride the app lanes — or your own machine.** The hosted path compiles
  C1's and C2's iOS/Android halves in the app build system (Codemagic today), where signing
  identities live; the matrix gate proves the layouts, the shared sources and the web halves
  from tarballs. And **`dsx export`** gives the same sources to you directly: a real Xcode
  project, a real Android Studio project, kernel vendored, your own modules compiled in —
  [native-export](../native-export.md). Nothing is withheld; the product is convenience, not
  capability.
- **C6 is an extension point, not a promise.** `RepoQuery` is frozen and proven on two
  transports (Postgres, Firestore). A third slots in behind the same seam when demand exists.
