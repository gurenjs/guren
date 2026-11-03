/**
 * A doc's description is its whole first paragraph, which can run to a hundred
 * words or stop on a colon before a list; the docs index shows the first
 * sentence of it. An English sentence ends at `.`, `!` or `?` followed by a
 * space and a capital, digit or opening mark, so `e.g. a` and `Node.js` do not
 * end one; a Japanese one at `。`.
 */
export function firstSentence(text: string): string {
  const japanese = /^(.+?。)/u.exec(text)
  if (japanese) return japanese[1]!
  const english = /^(.+?[.!?])(?=\s+[A-Z0-9(`"'])/u.exec(text)
  return english ? english[1]! : text
}
