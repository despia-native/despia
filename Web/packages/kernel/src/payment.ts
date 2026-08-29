//
//  payment.ts — the SHARED PURE CORE behind Core/Pay (F17.2): what a wallet payment request
//  IS, decided once and run identically by all three renderers.
//
//  THE MONEY IS THE WHOLE POINT. Apple Pay, Google Pay and the Payment Request API each take
//  a differently-shaped request and each fail differently when the line items do not add up
//  to the total: one shows a wrong number, one throws, one silently drops a row. So the
//  arithmetic, the currency exponents, the network vocabulary and the sum check live here and
//  are pinned by OpenSource/Conformance/pay/request.json. The platform sheets are plumbing.
//
//  BINARY FLOATS ARE REFUSED FOR FRACTIONAL AMOUNTS. `0.1 + 0.2` is not `0.3` in any of these
//  three languages, and a total that is off by one cent is the worst bug a checkout can have.
//  An amount is therefore a DECIMAL STRING in the currency's major unit ("12.34"), or a JSON
//  number only when it is a whole integer ("5" = five dollars). A fractional JSON number is
//  refused with a message that says to quote it. Everything downstream is integer minor units.
//
//  WHAT IS DELIBERATELY NOT HERE: the sheet, the token, and any knowledge of a PSP. The
//  resolved token goes to the developer's own processor and never touches anything of ours.
//

/** Currencies whose minor unit is not 1/100. Everything absent from this table is exponent 2,
 *  which is the ISO 4217 default and covers the overwhelming majority. */
const CURRENCY_EXPONENTS: Readonly<Record<string, number>> = {
  BIF: 0, CLP: 0, DJF: 0, GNF: 0, ISK: 0, JPY: 0, KMF: 0, KRW: 0, PYG: 0,
  RWF: 0, UGX: 0, UYI: 0, VND: 0, VUV: 0, XAF: 0, XOF: 0, XPF: 0,
  BHD: 3, IQD: 3, JOD: 3, KWD: 3, LYD: 3, OMR: 3, TND: 3,
};

/** A payment larger than this is a data-entry error, not a purchase. In minor units, so it is
 *  a trillion of the smallest coin. */
export const PAYMENT_MAX_MINOR = 1_000_000_000_000;

/** The canonical network vocabulary. camelCase names match the rest of the DSX surface; the
 *  platform spellings are produced at the boundary, never leaked into the contract. */
export const PAYMENT_NETWORKS: readonly string[] = [
  "amex", "cartesBancaires", "discover", "eftpos", "electron", "elo", "girocard",
  "interac", "jcb", "maestro", "mada", "mastercard", "unionPay", "visa",
];

/** Spellings the world actually writes, folded to the canonical word. The key is the input
 *  lowercased with spaces, hyphens and underscores removed. */
const NETWORK_ALIASES: Readonly<Record<string, string>> = {
  amex: "amex", americanexpress: "amex",
  cartesbancaires: "cartesBancaires", cb: "cartesBancaires",
  discover: "discover",
  eftpos: "eftpos", eftposaustralia: "eftpos",
  electron: "electron", visaelectron: "electron",
  elo: "elo",
  girocard: "girocard",
  interac: "interac",
  jcb: "jcb",
  maestro: "maestro",
  mada: "mada",
  mastercard: "mastercard", master: "mastercard",
  unionpay: "unionPay", chinaunionpay: "unionPay",
  visa: "visa",
};

/** What a merchant can accept beyond a plain card read. */
export const PAYMENT_CAPABILITIES: readonly string[] = ["threeDS", "debit", "credit", "emv"];

const CAPABILITY_ALIASES: Readonly<Record<string, string>> = {
  "3ds": "threeDS", threeds: "threeDS", "3dsecure": "threeDS",
  debit: "debit", credit: "credit", emv: "emv",
};

/** Fields the sheet may collect on the merchant's behalf. */
export const PAYMENT_FIELDS: readonly string[] = ["name", "email", "phone", "postalAddress"];

const FIELD_ALIASES: Readonly<Record<string, string>> = {
  name: "name", fullname: "name",
  email: "email", emailaddress: "email",
  phone: "phone", phonenumber: "phone",
  postaladdress: "postalAddress", address: "postalAddress", shippingaddress: "postalAddress",
};

/** How a completed authorization ended, as the sheet needs to be told. */
export const PAYMENT_STATUSES: readonly string[] = [
  "success", "failure", "invalidBillingAddress", "invalidShippingAddress",
  "invalidShippingContact", "pinRequired", "pinIncorrect", "pinLockout",
];

const STATUS_ALIASES: Readonly<Record<string, string>> = {
  success: "success", ok: "success", succeeded: "success",
  failure: "failure", failed: "failure", error: "failure",
  invalidbillingaddress: "invalidBillingAddress",
  invalidshippingaddress: "invalidShippingAddress",
  invalidshippingcontact: "invalidShippingContact",
  pinrequired: "pinRequired", pinincorrect: "pinIncorrect", pinlockout: "pinLockout",
};

export type PaymentRefusal =
  | "invalid_currency"
  | "invalid_amount"
  | "no_items"
  | "total_mismatch"
  | "missing_merchant"
  | "unknown_network"
  | "unknown_capability"
  | "unknown_field"
  | "unknown_status"
  | "invalid_label";

export type PaymentResult<T> = { ok: true; value: T } | { ok: false; error: PaymentRefusal; detail?: string };

export interface PaymentLine {
  readonly label: string;
  /** integer minor units; negative is a discount, which is legal on a line and not on a total */
  readonly amountMinor: number;
  /** `final` (the number is known) or `pending` (the sheet shows it as still being computed) */
  readonly kind: "final" | "pending";
}

export interface PaymentPlan {
  readonly merchant: string;
  readonly currency: string;
  readonly exponent: number;
  readonly items: readonly PaymentLine[];
  readonly total: PaymentLine;
  readonly networks: readonly string[];
  readonly capabilities: readonly string[];
  readonly shipping: readonly string[];
  readonly contact: readonly string[];
}

function fail<T>(error: PaymentRefusal, detail?: string): PaymentResult<T> {
  return detail === undefined ? { ok: false, error } : { ok: false, error, detail };
}

function foldKey(raw: unknown): string {
  return String(raw ?? "").toLowerCase().replace(/[\s\-_]/g, "");
}

/** The minor-unit exponent for an ISO 4217 code, or -1 when the code is not one. */
export function currencyExponent(raw: unknown): number {
  const code = String(raw ?? "").trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(code)) return -1;
  const known = CURRENCY_EXPONENTS[code];
  return known === undefined ? 2 : known;
}

function pow10(n: number): number {
  let out = 1;
  for (let i = 0; i < n; i += 1) out *= 10;
  return out;
}

/**
 * Parse a money amount into integer minor units.
 *
 * Accepts a decimal string in the currency's major unit, or a JSON number ONLY when it is a
 * whole integer. A fractional JSON number is refused: `0.1` is not `0.1` in binary, and a
 * checkout that is off by a cent for one customer in a thousand is unfixable after the fact.
 */
export function parseAmountMinor(raw: unknown, exponent: number): PaymentResult<number> {
  if (exponent < 0) return fail("invalid_currency");

  if (typeof raw === "number") {
    if (!Number.isFinite(raw)) return fail("invalid_amount", "not a finite number");
    if (!Number.isInteger(raw)) {
      return fail("invalid_amount", "quote a fractional amount as a string — binary floats cannot hold it exactly");
    }
    const minor = raw * pow10(exponent);
    if (Math.abs(minor) > PAYMENT_MAX_MINOR) return fail("invalid_amount", "out of range");
    return { ok: true, value: minor };
  }

  const text = typeof raw === "string" ? raw.trim() : "";
  const match = /^([+-]?)(\d+)(?:\.(\d+))?$/.exec(text);
  if (match === null) return fail("invalid_amount", "not a decimal amount");
  const sign = match[1] === "-" ? -1 : 1;
  const whole = match[2]!;
  const frac = match[3] ?? "";
  if (frac.length > exponent) {
    return fail("invalid_amount", `this currency has ${exponent} decimal place(s)`);
  }
  if (whole.length > 15) return fail("invalid_amount", "out of range");
  const padded = (frac + "0".repeat(exponent)).slice(0, exponent);
  const minor = sign * (Number(whole) * pow10(exponent) + (exponent > 0 ? Number(padded) : 0));
  if (Math.abs(minor) > PAYMENT_MAX_MINOR) return fail("invalid_amount", "out of range");
  return { ok: true, value: minor };
}

/** Render minor units back as the major-unit decimal string the sheet shows. Pinned so three
 *  renderers cannot disagree about whether it is `5`, `5.0` or `5.00`. */
export function formatAmountMinor(minor: number, exponent: number): string {
  const negative = minor < 0;
  const abs = Math.abs(Math.trunc(minor));
  if (exponent <= 0) return `${negative ? "-" : ""}${abs}`;
  const unit = pow10(exponent);
  const whole = Math.trunc(abs / unit);
  const rest = abs - whole * unit;
  return `${negative ? "-" : ""}${whole}.${String(rest).padStart(exponent, "0")}`;
}

/** Fold a caller's network list to the canonical vocabulary, deduped and in canonical order.
 *  An empty request means "everything this device can do", which is what a merchant almost
 *  always wants and is the only default that does not silently exclude a customer's card. */
export function foldNetworks(raw: unknown): PaymentResult<readonly string[]> {
  const list = Array.isArray(raw) ? raw : typeof raw === "string" && raw.length > 0 ? raw.split(",") : [];
  if (list.length === 0) return { ok: true, value: PAYMENT_NETWORKS };
  const seen = new Set<string>();
  for (const entry of list) {
    const canonical = NETWORK_ALIASES[foldKey(entry)];
    if (canonical === undefined) return fail("unknown_network", String(entry ?? ""));
    seen.add(canonical);
  }
  return { ok: true, value: PAYMENT_NETWORKS.filter((n) => seen.has(n)) };
}

function foldVocabulary(
  raw: unknown,
  aliases: Readonly<Record<string, string>>,
  canonicalOrder: readonly string[],
  refusal: PaymentRefusal,
  fallback: readonly string[],
): PaymentResult<readonly string[]> {
  const list = Array.isArray(raw) ? raw : typeof raw === "string" && raw.length > 0 ? raw.split(",") : [];
  if (list.length === 0) return { ok: true, value: fallback };
  const seen = new Set<string>();
  for (const entry of list) {
    const canonical = aliases[foldKey(entry)];
    if (canonical === undefined) return fail(refusal, String(entry ?? ""));
    seen.add(canonical);
  }
  return { ok: true, value: canonicalOrder.filter((n) => seen.has(n)) };
}

export function foldCapabilities(raw: unknown): PaymentResult<readonly string[]> {
  return foldVocabulary(raw, CAPABILITY_ALIASES, PAYMENT_CAPABILITIES, "unknown_capability",
    ["threeDS", "debit", "credit"]);
}

export function foldFields(raw: unknown): PaymentResult<readonly string[]> {
  return foldVocabulary(raw, FIELD_ALIASES, PAYMENT_FIELDS, "unknown_field", []);
}

/** Fold the outcome word `complete({ status })` carries. Unknown is refused rather than
 *  treated as failure: a typo that reads as "declined" is a support ticket nobody can explain. */
export function foldStatus(raw: unknown): PaymentResult<string> {
  const text = raw === undefined || raw === null || String(raw).trim().length === 0 ? "success" : String(raw);
  const canonical = STATUS_ALIASES[foldKey(text)];
  if (canonical === undefined) return fail("unknown_status", text);
  return { ok: true, value: canonical };
}

interface RawLine { label?: unknown; amount?: unknown; type?: unknown; kind?: unknown }

function parseLine(raw: unknown, exponent: number, allowPending: boolean): PaymentResult<PaymentLine> {
  if (raw === null || typeof raw !== "object") return fail("invalid_amount", "a line item must be an object");
  const line = raw as RawLine;
  const label = String(line.label ?? "").trim();
  if (label.length === 0) return fail("invalid_label", "every line the customer sees needs a label");
  const amount = parseAmountMinor(line.amount, exponent);
  if (amount.ok !== true) return fail(amount.error, amount.detail);
  const kindRaw = foldKey(line.kind ?? line.type ?? "");
  const kindWord = kindRaw.length === 0 ? "final" : kindRaw;
  if (kindWord !== "final" && kindWord !== "pending") {
    return fail("invalid_amount", "a line is `final` or `pending`");
  }
  if (kindWord === "pending" && !allowPending) {
    return fail("invalid_amount", "the total cannot be pending");
  }
  return { ok: true, value: { label, amountMinor: amount.value, kind: kindWord } };
}

export interface RawPaymentRequest {
  merchant?: unknown;
  currency?: unknown;
  items?: unknown;
  total?: unknown;
  networks?: unknown;
  capabilities?: unknown;
  shipping?: unknown;
  contact?: unknown;
}

/**
 * Validate and normalize a payment request into the plan every platform sheet is built from.
 *
 * THE SUM CHECK IS THE REASON THIS FUNCTION EXISTS. A request whose line items do not add up
 * to its total is the single most common wallet bug, and each platform hides it differently.
 * Here it is `total_mismatch` before a sheet ever appears, with both numbers in the detail.
 *
 * A PENDING line (a shipping cost still being computed) is exempt from the sum, because its
 * amount is by definition not yet known. The total itself may never be pending.
 */
export function normalizePaymentRequest(raw: RawPaymentRequest): PaymentResult<PaymentPlan> {
  const merchant = String(raw.merchant ?? "").trim();
  if (merchant.length === 0) return fail("missing_merchant");

  const currency = String(raw.currency ?? "").trim().toUpperCase();
  const exponent = currencyExponent(currency);
  if (exponent < 0) return fail("invalid_currency", currency);

  const rawItems = Array.isArray(raw.items) ? raw.items : [];
  if (rawItems.length === 0) return fail("no_items");

  const items: PaymentLine[] = [];
  for (const entry of rawItems) {
    const line = parseLine(entry, exponent, true);
    if (line.ok !== true) return fail(line.error, line.detail);
    items.push(line.value);
  }

  if (raw.total === undefined || raw.total === null) {
    return fail("invalid_amount", "a payment sheet needs a total line");
  }
  const totalLine = parseLine(raw.total, exponent, false);
  if (totalLine.ok !== true) return fail(totalLine.error, totalLine.detail);
  if (totalLine.value.amountMinor < 0) {
    return fail("invalid_amount", "a total cannot be negative");
  }

  let sum = 0;
  for (const item of items) {
    if (item.kind === "pending") continue;
    sum += item.amountMinor;
  }
  if (sum !== totalLine.value.amountMinor) {
    return fail("total_mismatch",
      `items add up to ${formatAmountMinor(sum, exponent)} but the total says ${formatAmountMinor(totalLine.value.amountMinor, exponent)}`);
  }

  const networks = foldNetworks(raw.networks);
  if (networks.ok !== true) return fail(networks.error, networks.detail);
  const capabilities = foldCapabilities(raw.capabilities);
  if (capabilities.ok !== true) return fail(capabilities.error, capabilities.detail);
  const shipping = foldFields(raw.shipping);
  if (shipping.ok !== true) return fail(shipping.error, shipping.detail);
  const contact = foldFields(raw.contact);
  if (contact.ok !== true) return fail(contact.error, contact.detail);

  return {
    ok: true,
    value: {
      merchant, currency, exponent, items, total: totalLine.value,
      networks: networks.value, capabilities: capabilities.value,
      shipping: shipping.value, contact: contact.value,
    },
  };
}

/** Human copy for each refusal, so three renderers apologise with one sentence. */
export const PAYMENT_MESSAGES: Readonly<Record<PaymentRefusal, string>> = {
  invalid_currency: "That is not an ISO 4217 currency code.",
  invalid_amount: "That is not an amount this currency can express.",
  no_items: "A payment sheet needs at least one line item.",
  total_mismatch: "The line items do not add up to the total.",
  missing_merchant: "A payment needs a merchant identifier.",
  unknown_network: "That is not a card network this sheet knows.",
  unknown_capability: "That is not a merchant capability this sheet knows.",
  unknown_field: "That is not a field the sheet can collect.",
  unknown_status: "That is not an outcome the sheet understands.",
  invalid_label: "Every line the customer sees needs a label.",
};
