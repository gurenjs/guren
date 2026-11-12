/** What an adapter adds to a column: a string is a decimal literal, already validated. */
export type IncrementValue = number | bigint | string

/** A decimal as every dialect reads it unquoted; the only string an adapter may inline. */
export const DECIMAL_LITERAL = /^-?\d+(?:\.\d+)?$/

/** `amount` with `sign` applied; `caller` names the method in the refusal. */
export function signedAmount(caller: string, amount: unknown, sign: 1 | -1): IncrementValue {
  if (typeof amount === 'bigint') return sign === 1 ? amount : -amount
  if (typeof amount === 'number' && Number.isFinite(amount)) return sign === 1 ? amount : -amount
  if (typeof amount === 'string' && DECIMAL_LITERAL.test(amount)) {
    if (sign === 1) return amount
    return amount.startsWith('-') ? amount.slice(1) : `-${amount}`
  }
  throw new TypeError(
    `${caller}() takes a finite number, a bigint, or a decimal string such as '10.50'; got ${typeof amount === 'string' ? JSON.stringify(amount) : String(amount)}.`,
  )
}
