//
//  firestore.live.test.ts — the SAME portability corpus, against a real Firestore service.
//
//  WHAT THIS FILE IS FOR. `repo-portability.test.ts` runs the real transport against an
//  in-process wire whose rules are parsed from the emitted `firestore.rules`. That proves the
//  transport; it cannot prove that GOOGLE's Firestore behaves the way this transport believes —
//  in particular that an owner-scoped `runQuery` really is refused unless it names its owner,
//  which is the assumption the whole owner-filter design rests on. Only the service itself can
//  settle that, so this file exists to point the identical corpus at one.
//
//  IT FAILS CLOSED when nothing is configured. `npm run test:firestore` starts Google's official
//  emulator and supplies this configuration, so the mandatory suite always executes; a direct
//  invocation without a reachable service must never masquerade as coverage. What it needs:
//
//    DSX_TEST_FIRESTORE_URL       REST root. The emulator is http://127.0.0.1:8080/v1 ;
//                                 production is https://firestore.googleapis.com/v1 .
//    DSX_TEST_FIRESTORE_PROJECT   the project id.
//    DSX_TEST_FIRESTORE_SERVICE   the credential that BYPASSES rules — "owner" against the
//                                 emulator, an access token minted from a service-account key
//                                 against a real project. Defaults to "owner".
//
//  USER IDENTITY. The corpus needs two distinct signed-in users. Against the EMULATOR that is
//  an unsigned JWT carrying the uid, which is the emulator's documented auth simulation and is
//  what `userToken` builds. Against a REAL project it needs genuine Firebase ID tokens, which
//  are credential work this suite deliberately does not do — minting them is exactly the token
//  handling a transport test must stay out of. So: point this at an emulator, or supply a
//  DSX_TEST_FIRESTORE_TOKEN_<uid> per user and it will use those verbatim.
//
//  The repository runner pins the Firebase CLI version, launches the Java emulator in a
//  disposable directory, executes all twelve cases, and propagates any failure.
//

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { installEntities, RepoSeam, type EntitySpec } from "../src/repo.ts";
import { installFirestore, type FetchLike } from "../src/firestore.ts";
import { ALICE, BOB, declaredEntities, repoPortability, type PortabilityBackend } from "./repo-portability.ts";

const HERE = import.meta.dirname ?? dirname(fileURLToPath(import.meta.url));
const ENTITIES = join(HERE, "..", "generated", "entities.json");

const URL_ = process.env["DSX_TEST_FIRESTORE_URL"] ?? "";
const PROJECT = process.env["DSX_TEST_FIRESTORE_PROJECT"] ?? "";
const SERVICE = process.env["DSX_TEST_FIRESTORE_SERVICE"] ?? "owner";

const ENTITY_SPECS: EntitySpec[] = declaredEntities(readFileSync(ENTITIES, "utf-8"));
const OWNED = ENTITY_SPECS.find((e) => e.ownership === "owner");
const SERVICE_ENTITY = ENTITY_SPECS.find((e) => e.ownership === "service");

const b64url = (value: string): string => Buffer.from(value, "utf-8").toString("base64url");

/**
 * The bearer for one user. An explicit per-uid token wins; otherwise an unsigned JWT, which the
 * Firestore emulator accepts and evaluates rules against. Nothing here signs anything — an
 * unsigned token is refused by every real service, which is the correct outcome when this is
 * pointed somewhere it should not be.
 */
function userToken(uid: string): string {
  const explicit = process.env[`DSX_TEST_FIRESTORE_TOKEN_${uid}`];
  if (typeof explicit === "string" && explicit !== "") return explicit;
  const header = b64url(JSON.stringify({ alg: "none", typ: "JWT" }));
  const payload = b64url(JSON.stringify({ sub: uid, user_id: uid, aud: PROJECT, iss: `https://securetoken.google.com/${PROJECT}` }));
  return `${header}.${payload}.`;
}

async function reachable(): Promise<string | false> {
  if (URL_ === "" || PROJECT === "") {
    return "set DSX_TEST_FIRESTORE_URL and DSX_TEST_FIRESTORE_PROJECT (an emulator at http://127.0.0.1:8080/v1 is the intended target)";
  }
  if (OWNED === undefined) return "no owner-scoped entity is declared";
  try {
    const probe = await fetch(`${URL_}/projects/${PROJECT}/databases/(default)/documents`, {
      headers: { authorization: `Bearer ${SERVICE}` },
      signal: AbortSignal.timeout(2000),
    });
    if (probe.status >= 500) return `firestore at ${URL_} answered ${probe.status}`;
    return false;
  } catch (e) {
    return `no firestore at ${URL_} (${e instanceof Error ? e.message : String(e)})`;
  }
}

const unavailable = await reachable();
if (unavailable !== false) throw new Error(unavailable);

/** Empty both collections, so each case starts from the same place a fresh store would. */
async function wipe(): Promise<void> {
  const root = `${URL_}/projects/${PROJECT}/databases/(default)/documents`;
  for (const spec of ENTITY_SPECS) {
    const listed = await fetch(`${root}/dsx_${spec.entity}?pageSize=300`, { headers: { authorization: `Bearer ${SERVICE}` } });
    if (!listed.ok) continue;
    const body = (await listed.json()) as { documents?: { name?: string }[] };
    for (const document of body.documents ?? []) {
      if (typeof document.name !== "string") continue;
      const tail = document.name.slice(document.name.indexOf("/documents") + "/documents".length);
      await fetch(`${root}${tail}`, { method: "DELETE", headers: { authorization: `Bearer ${SERVICE}` } });
    }
  }
}

const live: PortabilityBackend = {
  name: "firestore.live",
  entity: OWNED?.entity ?? "note",
  serviceEntity: SERVICE_ENTITY?.entity ?? null,
  // Firestore's service credential is the real rules-bypass face. The negative control uses it
  // for user-shaped calls so the same official emulator demonstrates that the corpus can see a
  // cross-owner row when policy enforcement is explicitly disabled. The ordinary cases keep
  // their per-user credentials and therefore continue to execute the emitted rules.
  supportsIsolationToggle: true,
  open: async (options) => {
    const enforceIsolation = options?.isolation !== false;
    await wipe();
    installEntities(ENTITY_SPECS);
    installFirestore({
      projectId: PROJECT,
      baseUrl: URL_,
      serviceToken: () => SERVICE,
      // The corpus's ctx carries `<uid>.jwt.sig` as the token; a live service needs a real
      // bearer for that uid, so the wire swaps it on the way out. The SUBJECT the transport
      // stamps into owner_id is untouched — this only translates the credential.
      fetch: (async (url, init) => {
        const headers = { ...(init?.headers ?? {}) };
        const bearer = headers["authorization"]?.replace(/^Bearer\s+/i, "");
        for (const uid of [ALICE, BOB]) {
          if (bearer === `${uid}.jwt.sig`) {
            headers["authorization"] = `Bearer ${enforceIsolation ? userToken(uid) : SERVICE}`;
          }
        }
        return fetch(url, { ...init, headers }) as unknown as ReturnType<FetchLike>;
      }) as FetchLike,
    });
    return { close: async () => { RepoSeam.transport = null; } };
  },
};

repoPortability(live);
