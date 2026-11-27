/**
 * Familista Manufacturing (M4) — amounts, as quotations carry them.
 *
 * An amount is a whole number of the currency's minor unit (cents, pence; yen have none), never a float. The currencies
 * are a closed list with their ISO 4217 exponents; a quotation in any other is refused rather than guessed. Nothing here
 * converts, rounds a price, or invents one: an amount is what a supplier quoted, as the Platform Owner recorded it.
 */
export const CURRENCY_EXPONENT: Readonly<Record<string, number>> = Object.freeze({
  EUR: 2, GBP: 2, USD: 2, CHF: 2, SEK: 2, NOK: 2, DKK: 2, PLN: 2, CZK: 2, RON: 2, TRY: 2,
  AED: 2, SAR: 2, QAR: 2, EGP: 2, MAD: 2, CNY: 2, INR: 2, PKR: 2, BDT: 2, CAD: 2, AUD: 2, BRL: 2, MXN: 2, JPY: 0, KRW: 0,
});
export const CURRENCIES: readonly string[] = Object.freeze(Object.keys(CURRENCY_EXPONENT).sort());
/** The largest amount a quotation may carry, in minor units: well inside a 32-bit integer. */
export const MAX_MINOR = 2_000_000_000;

export function isCurrency(c: unknown): c is string { return typeof c === 'string' && Object.prototype.hasOwnProperty.call(CURRENCY_EXPONENT, c); }
export function isMinor(n: unknown): n is number { return typeof n === 'number' && Number.isInteger(n) && n > 0 && n <= MAX_MINOR; }

/** A quotation's lines, when the supplier priced the designs apart: each its design, unit price and sets; the total theirs. */
export function linesTotal(lines: Array<{ unitMinor: number; sets: number }>): number {
  return lines.reduce((t, l) => t + l.unitMinor * l.sets, 0);
}
