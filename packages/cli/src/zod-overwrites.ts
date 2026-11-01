/**
 * zod's own string overwrites, recognised by their function source: `.trim()`, `.toLowerCase()`,
 * `.toUpperCase()` and `.normalize()` each attach an `overwrite` check whose `tx` reads as below.
 * Any other `.overwrite()` may rewrite a value arbitrarily, so a reader treats it as opaque.
 */
const TRIM_AND_CASE = ['(input) => input.trim()', '(input) => input.toLowerCase()', '(input) => input.toUpperCase()']

export const BUILT_IN_OVERWRITES: ReadonlySet<string> = new Set([...TRIM_AND_CASE, '(input) => input.normalize(form)'])

/** The ones a browser's email input agrees with: it strips surrounding whitespace and accepts either case. */
export const WHITESPACE_AND_CASE_OVERWRITES: ReadonlySet<string> = new Set(TRIM_AND_CASE)
