import test from "node:test";
import assert from "node:assert/strict";

import { facetBindingIdent, facetBootImport, facetBootRegister } from "../src/facet-binding.ts";

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

test("plain schemes stay themselves as bindings", () => {
  assert.equal(facetBindingIdent("viewport"), "viewport");
  assert.equal(facetBindingIdent("takescreenshot"), "takescreenshot");
  assert.equal(facetBindingIdent("base"), "base");
});

test("dotted schemes fold to legal JS identifiers; filenames stay the scheme", () => {
  for (const scheme of [
    "firebase.remoteconfig",
    "telemetry.console",
    "telemetry.http",
    "telemetry.posthog",
    "telemetry.sentry",
  ]) {
    const id = facetBindingIdent(scheme);
    assert.match(id, IDENT, scheme);
    assert.doesNotMatch(id, /\./, scheme);
    const line = facetBootImport(scheme);
    assert.match(line, new RegExp(`from "./modules/${scheme.replace(/\./g, "\\.")}\\.js"`));
    assert.doesNotMatch(line, /import\s+[A-Za-z0-9_]+\./);
    const register = facetBootRegister(scheme);
    assert.match(register, new RegExp(`ModuleRegistry\\.register\\(${id}\\)`));
    assert.doesNotMatch(register, /register\([A-Za-z0-9_]+\./);
  }
});

test("a leading digit or hyphen does not produce an illegal ident", () => {
  assert.equal(facetBindingIdent("3d"), "_3d");
  assert.equal(facetBindingIdent("-x"), "_x");
  assert.match(facetBindingIdent("3d"), IDENT);
});

test("aliases ride JSON, never the binding", () => {
  assert.equal(
    facetBootRegister("firebase.remoteconfig", ["legacy-rc"]),
    'ModuleRegistry.register(firebase_remoteconfig, { aliases: ["legacy-rc"] });',
  );
});
