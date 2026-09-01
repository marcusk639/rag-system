/**
 * Compiled-in implementations a pack may reference BY NAME (platform spec §3.4).
 * A pack cannot supply code; unusual verticals get a new entry here and an image
 * rebuild, so the supply chain stays auditable.
 */

/** Luhn check — cheap and precise, kills most false card matches. */
function luhnValid(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (d < 0 || d > 9) return false;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return digits.length > 0 && sum % 10 === 0;
}

/** ABA routing checksum: 3(d1+d4+d7) + 7(d2+d5+d8) + (d3+d6+d9) ≡ 0 mod 10. */
function abaValid(digits: string): boolean {
  if (!/^\d{9}$/.test(digits)) return false;
  const d = [...digits].map((c) => c.charCodeAt(0) - 48);
  const sum =
    3 * (d[0]! + d[3]! + d[6]!) +
    7 * (d[1]! + d[4]! + d[7]!) +
    1 * (d[2]! + d[5]! + d[8]!);
  return sum % 10 === 0;
}

const VALIDATORS: Record<string, (m: string) => boolean> = {
  luhn: (m) => luhnValid(m.replace(/[ -]/g, "")),
  aba: (m) => abaValid(m),
};

const CONTEXTS: Record<string, RegExp> = {
  "account-vocab":
    /\b(account|acct|routing|aba|bank|iban|swift|deposit|wire)\b/i,
};

export const VALIDATOR_NAMES: readonly string[] = Object.keys(VALIDATORS);
export const CONTEXT_NAMES: readonly string[] = Object.keys(CONTEXTS);

export function resolveValidator(name: string): (m: string) => boolean {
  const fn = VALIDATORS[name];
  if (!fn)
    throw new Error(
      `unknown validator "${name}" — packs may only reference compiled-in names`,
    );
  return fn;
}

export function resolveContext(name: string): RegExp {
  const re = CONTEXTS[name];
  if (!re)
    throw new Error(
      `unknown context "${name}" — packs may only reference compiled-in names`,
    );
  return re;
}
