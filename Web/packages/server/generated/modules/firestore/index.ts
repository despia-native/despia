//
//  Firestore provider — server residence (plan B5, the SECOND transport).
//
//  The Postgres residence exists to carry a DRIVER: `pg` is a real dependency, lazily loaded in
//  two spellings, external to every bundle, and excluding that module removes it. This one
//  carries NOTHING, and that is the headline rather than an omission — `src/firestore.ts` speaks
//  the REST API over the runtime's own `fetch`, so the module's manifest declares no
//  `web.server_dependencies`, the Dockerfile grows no install line, and the emitted bundle gains
//  no external. A provider is allowed to be this small; what makes it a provider is that it
//  fills the seam, not that it ships a vendor client.
//
//  Structurally typed, and the only path it names is the workspace's own transport — sources are
//  COPIED to a fixed depth (generated/modules/<chain>/), so relative paths must not reach beyond
//  the package root.
//
//  WHICH SEAMS THIS FILLS: the repository, and DELIBERATELY NOT THE QUEUE. `installFirestore`
//  leaves `QueueSeam` alone because an atomic claim in Firestore is a transaction with a
//  per-document precondition and a retry loop — a different protocol from SKIP LOCKED, which
//  deserves to be written rather than approximated. So a tree configured for firestore that also
//  drains a queue gets `no_provider` naming the fix, which is the honest answer and not a silent
//  one. (It is also why `data_backend` is a per-app choice and the framework profile enables
//  both provider modules: the two-implementation freeze rule wants both emitters running every
//  build.)
//
//  CREDENTIALS ARE INJECTED, NEVER MINTED. `serviceToken` returns whatever the deploy put in
//  DSX_FIRESTORE_ACCESS_TOKEN and does no signing of its own: minting one means holding a
//  service-account private key and issuing assertions against it, which is a token-issuing
//  surface this file must not become. A deployment that rotates the credential re-injects it;
//  the token function is read on EVERY service query precisely so that re-injection is possible
//  without a rebuild, and a process that outlives its token gets the transport's typed
//  `forbidden` (401 always throws — an expired credential must never read as "the database is
//  empty") rather than a quietly empty answer.
//
//  Returning null is the honest state of a deployment with no service credential: a
//  service-scoped query then FAILS CLOSED naming the setting, and every user-scoped query — the
//  ordinary case, where the rules evaluate the caller's own bearer — keeps working untouched.
//

import { installFirestore } from "../../../src/firestore.ts";

/**
 * Fill the repository seam with the Firestore REST transport.
 *
 * A missing project id returns `installed: false` rather than throwing, exactly like the Postgres
 * residence: the required-config gate is the loud failure (it names the field and the env var),
 * and failing again here would shadow that message with a worse one.
 */
export async function installDataProvider(
  env: (key: string) => string | undefined,
): Promise<{ installed: boolean; backend: string }> {
  const projectId = env("DSX_FIREBASE_PROJECT_ID");
  if (projectId === undefined || projectId === "") return { installed: false, backend: "firestore" };
  installFirestore({
    projectId,
    // Read per call, not captured once — see the header note on rotation.
    serviceToken: () => env("DSX_FIRESTORE_ACCESS_TOKEN") ?? null,
  });
  return { installed: true, backend: "firestore" };
}
