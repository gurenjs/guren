/** What an adapter adds to a column; a string must match `DECIMAL_LITERAL`. */
export type IncrementValue = number | bigint | string

/** A decimal as every dialect reads it unquoted; the only string an adapter may inline. */
export const DECIMAL_LITERAL = /^-?\d+(?:\.\d+)?$/

/** Refuses anything but a finite number, a bigint or a `DECIMAL_LITERAL` string. */
export function signedAmount(caller: string, amount: unknown, negate: boolean): IncrementValue {
  if (typeof amount === 'bigint' || (typeof amount === 'number' && Number.isFinite(amount))) return negate ? -amount : amount
  if (typeof amount === 'string' && DECIMAL_LITERAL.test(amount)) {
    if (!negate) return amount
    return amount.startsWith('-') ? amount.slice(1) : `-${amount}`
  }
  throw new TypeError(
    `${caller}() takes a finite number, a bigint, or a decimal string such as '10.50'; got ${typeof amount === 'string' ? JSON.stringify(amount) : String(amount)}.`,
  )
}
