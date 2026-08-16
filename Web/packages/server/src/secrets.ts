//
//  secrets.ts — comparing a presented credential against the expected one, in constant time.
//
//  ONE SPELLING, ON PURPOSE. This started as a private helper in host.ts, and the moment a
//  second endpoint had to check a second kind of shared secret (webhook.ts) the choice was to
//  copy five lines or to name them. A copy is how one of the two ends up with an early return
//  after somebody "simplifies" it, and a timing leak is invisible in review and invisible in
//  tests — it shows up only as an endpoint that can be probed byte by byte.
//

/**
 * Compare two secrets WITHOUT leaking their contents through timing.
 *
 * `a === b` on strings returns at the first differing byte, so the time it takes is a function of
 * how long a shared prefix the caller guessed. Against an endpoint that tolerates being probed
 * indefinitely — a cron target, a webhook receiver — that is a byte-at-a-time oracle for
 * recovering the key. Accumulating XOR over every position costs the same for every input.
 *
 * The length check is deliberately kept: it leaks only the LENGTH, which is not the secret, and
 * without it the loop below would have to pick a comparison length and would leak more.
 */
export function secretEquals(presented: string | null | undefined, expected: string): boolean {
  if (typeof presented !== "string" || presented.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= presented.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}
