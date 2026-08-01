import type { MailAddress } from './types'

/**
 * Parse an email address string or object into MailAddress, supporting the
 * `Name <email>` format. Parsed with string scanning — the previous
 * `/^(.+)\s*<(.+)>$/` backtracks polynomially on crafted recipient strings,
 * which can be request-derived (e.g. password reset forms).
 */
export function parseMailAddress(input: string | MailAddress): MailAddress {
  if (typeof input !== 'string') {
    return input
  }

  // Line breaks disqualify the Name <email> form (as `.` did in the regex
  // this replaces) — a parsed display name must never carry header-injection
  // characters into mail transports.
  if (input.endsWith('>') && !/[\r\n\u2028\u2029]/u.test(input)) {
    const open = input.lastIndexOf('<')
    if (open > 0 && open < input.length - 2) {
      return {
        name: input.slice(0, open).trim(),
        email: input.slice(open + 1, -1).trim(),
      }
    }
  }

  return { email: input }
}
