//
//  forms-conformance.test.ts — the SHARED FORMS corpus
//  (OpenSource/Conformance/forms/{mask,countries,phone,daterange,validation,composites}
//  .json) through the TS forms kernel — the REFERENCE leg of U08. The Kotlin twin
//  (:core FormsConformanceTest) and the Swift twin (record lane, FormsConformance) run
//  the SAME files, so "where is the caret after an edit in the middle of a masked value"
//  cannot have three answers. Expected values were computed by an independent scratch
//  implementation, never by this kernel.
//

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";

import {
  maskCapacity, maskDescription, maskEdit, maskExtract, maskFormat,
  FORMS_COUNTRIES, FORMS_DEFAULT_COUNTRY, formsCountry, formsFlag, phoneParse,
  formsDayNumber, formsDateFromDay, formsMonthGrid, formsSelectable, formsDateFold,
  formsRule, formsFieldError, formsAggregate, formsSubmit,
  multiSelectToggle, multiSelectAnnouncement, tagsAdd, tagsBackspace, tagsAnnouncement,
  type DateFoldEvent, type FormFieldState,
} from "../src/forms.ts";

function corpusDir(): string {
  let dir = resolve(import.meta.dirname ?? ".");
  for (;;) {
    const candidate = join(dir, "OpenSource/Conformance/forms");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) throw new Error("forms corpus not found");
    dir = parent;
  }
}

function load<T>(file: string): T {
  return JSON.parse(readFileSync(join(corpusDir(), file), "utf-8")) as T;
}

// ── countries.json — ONE table, asserted byte-for-byte against the shipped literal ────

type CountryRow = {
  iso: string; name: string; dial: string; trunk: string;
  nsnMin: number; nsnMax: number; format: string | null; primary: boolean;
};
const countriesDoc = load<{ default: string; countries: CountryRow[] }>("countries.json");

test("forms/countries — the kernel table IS the corpus table", () => {
  assert.equal(FORMS_DEFAULT_COUNTRY, countriesDoc.default);
  assert.equal(FORMS_COUNTRIES.length, countriesDoc.countries.length);
  assert.ok(FORMS_COUNTRIES.length >= 60, "the country table is suspiciously small");
  for (let i = 0; i < countriesDoc.countries.length; i += 1) {
    const want = countriesDoc.countries[i]!;
    const got = FORMS_COUNTRIES[i]!;
    assert.deepEqual(
      { iso: got.iso, name: got.name, dial: got.dial, trunk: got.trunk,
        nsnMin: got.nsnMin, nsnMax: got.nsnMax, format: got.format, primary: got.primary },
      want, `country row ${i} (${want.iso})`,
    );
  }
});

test("forms/countries — a national format never truncates a legal number", () => {
  for (const row of countriesDoc.countries) {
    if (row.format === null) continue;
    assert.equal(row.nsnMin, row.nsnMax, `${row.iso}: a format needs a fixed NSN length`);
    assert.equal(maskCapacity(row.format), row.nsnMin, `${row.iso}: format capacity != NSN length`);
  }
});

test("forms/countries — every ISO is unique and resolvable", () => {
  const seen = new Set<string>();
  for (const row of countriesDoc.countries) {
    assert.ok(!seen.has(row.iso), `duplicate ISO ${row.iso}`);
    seen.add(row.iso);
    assert.equal(formsCountry(row.iso)?.dial, row.dial);
    assert.equal(formsCountry(row.iso.toLowerCase())?.dial, row.dial);
  }
});

// ── mask.json ─────────────────────────────────────────────────────────────────────────

type MaskDoc = {
  capacity: { mask: string; capacity: number; description: string }[];
  format: { mask: string; raw: string; display: string; extract: string }[];
  extract: { mask: string; text: string; raw: string }[];
  edits: {
    name: string; mask: string; prev: string; selStart: number; selEnd: number; insert: string;
    expect: { display: string; caret: number; raw: string; complete: boolean };
  }[];
};
const maskDoc = load<MaskDoc>("mask.json");
assert.ok(maskDoc.edits.length >= 20, "forms/mask edits corpus is suspiciously small");

for (const c of maskDoc.capacity) {
  test(`forms/mask capacity — ${JSON.stringify(c.mask)}`, () => {
    assert.equal(maskCapacity(c.mask), c.capacity);
    assert.equal(maskDescription(c.mask), c.description);
  });
}

for (const c of maskDoc.format) {
  test(`forms/mask format — ${JSON.stringify(c.mask)} <- ${JSON.stringify(c.raw)}`, () => {
    assert.equal(maskFormat(c.mask, c.raw), c.display);
    assert.equal(maskExtract(c.mask, c.display), c.extract);
  });
}

for (const c of maskDoc.extract) {
  test(`forms/mask extract — ${JSON.stringify(c.mask)} <- ${JSON.stringify(c.text)}`, () => {
    assert.equal(maskExtract(c.mask, c.text), c.raw);
  });
}

for (const c of maskDoc.edits) {
  test(`forms/mask edit — ${c.name}`, () => {
    const got = maskEdit(c.mask, c.prev, c.selStart, c.selEnd, c.insert);
    assert.deepEqual(
      { display: got.display, caret: got.caret, raw: got.raw, complete: got.complete },
      c.expect,
    );
  });
}

test("forms/mask — bind receives the UNMASKED value, always", () => {
  for (const c of maskDoc.edits) {
    assert.equal(maskExtract(c.mask, c.expect.display), c.expect.raw,
      `${c.name}: display and raw disagree`);
  }
});

// ── phone.json ────────────────────────────────────────────────────────────────────────

type PhoneDoc = {
  flags: { iso: string; flag: string }[];
  parse: {
    input: string; defaultCountry: string | null;
    expect: { e164: string; national: string; country: string | null;
              dialCode: string; nsn: string; valid: boolean };
  }[];
};
const phoneDoc = load<PhoneDoc>("phone.json");
assert.ok(phoneDoc.parse.length >= 30, "forms/phone parse corpus is suspiciously small");

for (const c of phoneDoc.flags) {
  test(`forms/phone flag — ${c.iso}`, () => { assert.equal(formsFlag(c.iso), c.flag); });
}

for (const c of phoneDoc.parse) {
  test(`forms/phone parse — ${JSON.stringify(c.input)} @ ${c.defaultCountry ?? "-"}`, () => {
    const got = phoneParse(c.input, c.defaultCountry);
    assert.deepEqual(
      { e164: got.e164, national: got.national, country: got.country,
        dialCode: got.dialCode, nsn: got.nsn, valid: got.valid },
      c.expect,
    );
  });
}

test("forms/phone — a valid parse round-trips through its own E.164", () => {
  for (const c of phoneDoc.parse) {
    if (!c.expect.valid) continue;
    const again = phoneParse(c.expect.e164, null);
    assert.equal(again.e164, c.expect.e164, `${c.input} did not round-trip`);
    assert.equal(again.valid, true, `${c.input} lost validity on round-trip`);
  }
});

// ── daterange.json ────────────────────────────────────────────────────────────────────

type DateDoc = {
  grid: { year: number; month: number; firstWeekday: number;
          expect: { days: number; leading: number; weeks: number } }[];
  dayNumbers: { date: string; day: number | null }[];
  dstAdjacency: { from: string; to: string; delta: number; next: string }[];
  selectable: { config: { min?: string; max?: string; disabledDates?: string[] };
                date: string; expect: { ok: boolean; reason: string } }[];
  folds: {
    name: string;
    config: { range?: boolean; min?: string; max?: string; disabledDates?: string[]; month?: string };
    events: DateFoldEvent[];
    expect: { start: string | null; end: string | null; month: string;
              complete: boolean; reason: string; fired: string[] }[];
  }[];
};
const dateDoc = load<DateDoc>("daterange.json");
assert.ok(dateDoc.folds.length >= 10, "forms/daterange fold corpus is suspiciously small");

for (const c of dateDoc.grid) {
  test(`forms/daterange grid — ${c.year}-${c.month} fw${c.firstWeekday}`, () => {
    assert.deepEqual({ ...formsMonthGrid(c.year, c.month, c.firstWeekday) }, c.expect);
  });
}

for (const c of dateDoc.dayNumbers) {
  test(`forms/daterange dayNumber — ${c.date}`, () => {
    assert.equal(formsDayNumber(c.date), c.day);
    if (c.day !== null) assert.equal(formsDateFromDay(c.day), c.date);
  });
}

for (const c of dateDoc.dstAdjacency) {
  test(`forms/daterange DST — ${c.from} -> ${c.to} is exactly one day`, () => {
    assert.equal((formsDayNumber(c.to) ?? 0) - (formsDayNumber(c.from) ?? 0), c.delta);
    assert.equal(formsDateFromDay((formsDayNumber(c.from) ?? 0) + 1), c.next);
  });
}

for (const c of dateDoc.selectable) {
  test(`forms/daterange selectable — ${c.date}`, () => {
    assert.deepEqual({ ...formsSelectable(c.config, c.date) }, c.expect);
  });
}

for (const c of dateDoc.folds) {
  test(`forms/daterange fold — ${c.name}`, () => {
    const steps = formsDateFold(c.config, c.events);
    assert.equal(steps.length, c.expect.length);
    for (let i = 0; i < steps.length; i += 1) {
      assert.deepEqual(
        { start: steps[i]!.start, end: steps[i]!.end, month: steps[i]!.month,
          complete: steps[i]!.complete, reason: steps[i]!.reason, fired: [...steps[i]!.fired] },
        c.expect[i], `step ${i}`,
      );
    }
  });
}

// ── validation.json ───────────────────────────────────────────────────────────────────

type ValidationDoc = {
  rules: { rule: string; arg: string; value: string; pattern: string; expect: boolean }[];
  fieldErrors: { field: FormFieldState; expect: string }[];
  aggregate: { name: string; fields: FormFieldState[];
               expect: { valid: boolean; dirty: boolean; errors: Record<string, string>; invalid: string[] } }[];
  submit: { name: string; state: { submitting: boolean; disabled: boolean };
            fields: FormFieldState[]; expect: Record<string, unknown> }[];
};
const validationDoc = load<ValidationDoc>("validation.json");
assert.ok(validationDoc.rules.length >= 15, "forms/validation rules corpus is suspiciously small");

for (const c of validationDoc.rules) {
  test(`forms/validation rule — ${c.rule}(${c.arg}) <- ${JSON.stringify(c.value)}`, () => {
    assert.equal(formsRule(c.rule, c.arg, c.value, c.pattern), c.expect);
  });
}

for (const [i, c] of validationDoc.fieldErrors.entries()) {
  test(`forms/validation fieldError — ${i} ${JSON.stringify(c.field.value ?? "")}`, () => {
    assert.equal(formsFieldError(c.field), c.expect);
  });
}

for (const c of validationDoc.aggregate) {
  test(`forms/validation aggregate — ${c.name}`, () => {
    const got = formsAggregate(c.fields);
    assert.deepEqual(
      { valid: got.valid, dirty: got.dirty, errors: got.errors, invalid: [...got.invalid] },
      c.expect,
    );
  });
}

for (const c of validationDoc.submit) {
  test(`forms/validation submit — ${c.name}`, () => {
    const got = formsSubmit(c.state, c.fields) as unknown as Record<string, unknown>;
    for (const [k, v] of Object.entries(c.expect)) {
      if (Array.isArray(v)) assert.deepEqual([...(got[k] as unknown[])], v, k);
      else assert.equal(got[k], v, k);
    }
  });
}

// ── composites.json ───────────────────────────────────────────────────────────────────

type CompositesDoc = {
  multiSelect: { selected: string[]; value: string; max: number;
                 expect: { selected: string[]; changed: boolean; reason: string } }[];
  multiSelectAnnouncement: { count: number; max: number; expect: string }[];
  tagsAdd: { tags: string[]; text: string;
             config: { separator?: string; max?: number; validate?: string };
             expect: { tags: string[]; added: string[]; rejected: { tag: string; reason: string }[] } }[];
  tagsBackspace: { tags: string[]; query: string;
                   expect: { tags: string[]; removed: string | null } }[];
  tagsAnnouncement: { kind: "add" | "remove"; tag: string; count: number; expect: string }[];
};
const composites = load<CompositesDoc>("composites.json");

for (const [i, c] of composites.multiSelect.entries()) {
  test(`forms/composites multiSelectToggle — ${i} ${c.value}`, () => {
    const got = multiSelectToggle(c.selected, c.value, c.max);
    assert.deepEqual({ selected: [...got.selected], changed: got.changed, reason: got.reason }, c.expect);
  });
}

for (const c of composites.multiSelectAnnouncement) {
  test(`forms/composites multiSelectAnnouncement — ${c.count}/${c.max}`, () => {
    assert.equal(multiSelectAnnouncement(c.count, c.max), c.expect);
  });
}

for (const [i, c] of composites.tagsAdd.entries()) {
  test(`forms/composites tagsAdd — ${i} ${JSON.stringify(c.text)}`, () => {
    const got = tagsAdd(c.tags, c.text, c.config);
    assert.deepEqual(
      { tags: [...got.tags], added: [...got.added], rejected: got.rejected.map((r) => ({ ...r })) },
      c.expect,
    );
  });
}

for (const [i, c] of composites.tagsBackspace.entries()) {
  test(`forms/composites tagsBackspace — ${i}`, () => {
    const got = tagsBackspace(c.tags, c.query);
    assert.deepEqual({ tags: [...got.tags], removed: got.removed }, c.expect);
  });
}

for (const c of composites.tagsAnnouncement) {
  test(`forms/composites tagsAnnouncement — ${c.kind} ${c.tag}`, () => {
    assert.equal(tagsAnnouncement(c.kind, c.tag, c.count), c.expect);
  });
}
