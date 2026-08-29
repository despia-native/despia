# forms/ — the FORMS pure core (mask · E.164 · date-range · validity)

The four pieces of `U08 Forms` that must not be implemented three times: the input
**mask engine**, **E.164** parse/format/validate, the **date-range validity fold**, and
**form validity aggregation** (plus the `<multiselect>` / `<tagsfield>` folds and the
accessibility announcements they speak). Every one is a pure function of its inputs, so
it is pinned here as data and executed by three runners against three implementations.

Why these four and not the widgets: each is a place where a naive implementation is
*almost* right, three independent ones are three different bugs, and the bug only shows
up in a user's hands. Caret position after an edit in the middle of a masked value is the
canonical example — it is the single most commonly broken behaviour in form libraries.

## The files

| file | pins |
| --- | --- |
| `mask.json` | the mask token grammar, the lazy-literal format law, extraction, and **`maskEdit`** — the caret law, the paste-into-the-middle case, and the backspace-over-a-separator case |
| `countries.json` | **the one country / dial-code table**, shared verbatim by all three renderers |
| `phone.json` | E.164 parse / national format / validity across a spread of countries, and `formsFlag` |
| `daterange.json` | civil-date arithmetic, the month grid, selectability, and the range fold with `min`/`max`/`disabledDates`/`on:month` |
| `validation.json` | the rule vocabulary, per-field error selection, form aggregation, and the **submit gate** (the double-submit law) |
| `composites.json` | the `<multiselect>` and `<tagsfield>` folds and their announcements |

Every expected value in every file was computed by an **independent scratch
implementation** written from the prose laws below, never by a kernel under test. The
laws themselves live in each file's `_note`, so a runner author never has to read this
page to know what a field means.

## The laws, in one screen

### Mask

Tokens: `#` a digit, `A` an ASCII letter, `*` an ASCII letter or digit, `\x` the literal
`x`, anything else a literal.

- **Lazy literals.** Walking the mask, a literal is emitted only while unplaced raw
  characters remain. `(415` never shows a dangling `) `.
- **Extraction.** A character is *significant* iff at least one placeholder class
  appearing in the mask accepts it. `bind` receives the significant characters (the
  **unmasked** value); `boundFormatted` receives the display. An app that stores the
  formatted string regrets it the first time it calls an API.
- **Placement.** `maskEdit`'s `raw` is the significant characters the mask actually
  **accepted**. A character no remaining slot will take is dropped from the value as well
  as from the display, so `maskExtract(mask, display) == raw` always holds. Without it a
  mixed-class mask (`AA-####` fed `12ab34`) binds two digits it never shows, reads as full
  at capacity, and then refuses to accept another keystroke.
- **The edit primitive.** `maskEdit(mask, prev, selStart, selEnd, insert)` replaces
  `prev[selStart:selEnd]` with `insert`. Every platform reduces to it: UIKit's
  `textField(_:shouldChangeCharactersIn:replacementString:)`, the web's `beforeinput`
  target range, Compose's `TextFieldValue` diff.
- **The separator swallow.** A deletion whose removed span holds no significant character
  extends to swallow the nearest significant character to its **left**, else the nearest
  to its **right**. This is why backspacing over `) ` deletes a digit instead of doing
  nothing.
- **The caret.** The new caret sits immediately after the *N*th significant character of
  the new display, where *N* is the number of significant characters preceding the edit
  point (head + insert), clamped to capacity.
- **Accessibility.** `maskDescription(mask)` is the announced expectation
  (`Format (###) ###-####, 10 digits`) — a masked field announces its FORMAT, not only its
  value.

### E.164

Parse: keep the digits, remember a leading `+` (a leading `00` is the same international
escape). International input resolves the **longest primary dial-code prefix**; no match
is a typed failure, never a guess. National input uses `defaultCountry`, strips the trunk
prefix, and — for a country with no trunk prefix — strips a leading dial code that leaves
a legal NSN (the NANP `1 415 …` habit). `valid` is `nsnMin <= len(nsn) <= nsnMax` and the
NSN does not itself start with `0`.

`formsFlag(iso)` is a pure function (two regional-indicator code points), so no flag is
stored in the table.

### Date range

All arithmetic is the proleptic-Gregorian **day count** over ISO civil dates. There is no
timezone anywhere in this fold, which is precisely why a DST transition day is exactly one
day long on all three runtimes — the 23-hour bug cannot be expressed. A select before an
open start **restarts** the range rather than swapping it; a close whose span contains a
disabled date is refused **whole**, because a hotel cannot sell across a blackout night.
`on:month` fires only when the visible month actually changes.

### Validity

`required` is the only rule an empty value can fail — every other rule passes on empty, so
`validate="email"` alone never blocks an untouched optional field. The first failing rule
owns the message. `form.valid` is "no registered field carries an error", `form.dirty` is
"some field differs from its initial value", and the `on:invalid` payload is the offending
field names in registration order.

**The double-submit law.** A submit while `submitting` is already true, or while the form
is `disabled`, is `blocked` and runs nothing. That is the framework-level answer to a
double-tapped order button, and it is the reason `submitting` exists at all.

## Where the table came from

`countries.json` is a **from-scratch trimmed transcription**, not a copy of anyone's file:

- `dial` — the ITU-T **E.164** country-code assignments; `iso` — **ISO 3166-1 alpha-2**.
- `trunk`, `nsnMin`, `nsnMax` — the national trunk prefix and the national-significant-number
  length bounds, transcribed per country and cross-checked against the ranges published in
  Google's **libphonenumber** metadata (Apache-2.0). No libphonenumber code, data file or
  generated artefact is vendored, imported or resolved here; the numbers are facts about
  numbering plans, and the table is the trimmed subset U08's plan calls for
  (`U08-forms.md` §10: *no bundled full phone-metadata library*).
- `format` — the national display mask, present **only** where the grouping is uniform. The
  invariant `nsnMin == nsnMax == capacity(format)` is asserted by every runner, so a mask
  can never truncate a legal number.
- `primary` — resolves a shared dial code.

70 countries, chosen for coverage of every continent, every dial-code length (1–3 digits),
both shared codes, and the trunk-prefix shapes (`""`, `"0"`, `"06"`, `"8"`).

## Named absences

Pinned so nobody mistakes silence for coverage.

- **+1 is not refined by area code.** `+13061234567` resolves to `US`, not `CA`. Refining a
  shared dial code needs an area-code table an order of magnitude larger than this one; the
  E.164 value — the thing `bind` receives and an API consumes — is correct either way.
- **Area-code-dependent national grouping** (UK, Italy, Germany, Brazil) carries no
  `format`, so `national` is the bare NSN behind the trunk prefix. Adding those needs
  per-prefix rules, which is the full metadata library the plan refuses.
- **The trunk prefix is always shown** in `national` when the country has one. A few
  numbering plans conventionally omit it for mobiles (notably CN); E.164 is unaffected.
- **Granularity below a day.** The fold is civil-date only. `granularity="hour"|"minute"`
  rounds the *bound value* at the element, and that rounding is not modelled here.
- **Locale-specific announcement strings.** The announcements are pinned in English at the
  kernel; localization is the renderer's display-string choke point, as everywhere else.

## The runner ledger

| runner | file | when |
| --- | --- | --- |
| **TS** (reference) | `OpenSource/Web/packages/kernel/test/forms-conformance.test.ts` | per-PR (`node --test`, `npm test`) |
| **Kotlin** | `OpenSource/Engine/Android/core/src/test/kotlin/despia/engine/FormsConformanceTest.kt` | `gradle test` (`:core`, SDK-free) |
| **Swift** | `OpenSource/Engine/iOS/FormsConformance.swift` → `FormsConformance` | the record lane (`RecordMain.swift`) |
