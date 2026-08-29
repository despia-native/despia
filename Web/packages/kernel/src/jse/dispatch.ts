//
//  dispatch.ts - the two name sets the runner dispatches on.
//
//  `rows.map(f)` and `text.trim()` lex as ONE dotted identifier, and what decides whether the
//  trailing segment is a METHOD on the path in front of it - rather than part of a name - is
//  membership of one of these sets. The evaluator needs them to run an expression; the
//  editor's span parser needs the same answer to DRAW one, and a second copy of the list is
//  a second opinion about what the language is. So they live here, once, and both read them.
//

/** The higher-order arms: the runner passes a LAMBDA into each of these. */
export const higherOrderFns: ReadonlySet<string> = new Set([
  "filter", "reject", "map", "find", "some", "every", "sortBy", "sumBy", "reduce", "forEach",
  "sort", "flatMap", "findIndex", "groupBy", "keyBy",
  "findLast", "findLastIndex", "reduceRight", "toSorted",
]);

/** Every other name a dotted call dispatches as a method on the value in front of it. */
export const methodFns: ReadonlySet<string> = new Set([
  "includes", "indexOf", "join", "reverse", "slice", "toUpperCase", "toLowerCase", "trim",
  "startsWith", "endsWith", "localeCompare",
  "toString", "padStart", "padEnd", "toHex", "toBase64", "encode", "decode",
  "get", "getAll", "has", "set", "append", "delete", "format", "json", "text", "abort",
  "getTime", "toISOString", "toJSON", "getFullYear", "getMonth", "getDate", "getDay",
  "getHours", "getMinutes", "getSeconds", "getMilliseconds",
  "getUTCFullYear", "getUTCMonth", "getUTCDate", "getUTCDay", "getUTCHours",
  "getUTCMinutes", "getUTCSeconds", "getUTCMilliseconds", "getTimezoneOffset",
  "setTime", "setFullYear", "setMonth", "setDate", "setHours", "setMinutes",
  "setSeconds", "setMilliseconds",
  "toLocaleDateString", "toLocaleTimeString", "toLocaleString",
  "flat", "concat", "at", "add",
  "test", "match", "replace", "replaceAll", "split", "search",
  "repeat", "substring", "lastIndexOf", "trimStart", "trimEnd", "charAt", "charCodeAt",
  "codePointAt", "normalize", "matchAll", "fill", "toReversed", "with", "toSpliced",
  "pop", "shift",
  "entries", "keys", "values", "toFixed",
]);
