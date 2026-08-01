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

  if (input.endsWith('>')) {
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
