/**
 * Slash-trimming without regex: patterns like `/\/+$/` backtrack
 * quadratically on adversarial input (long slash runs mid-string), and
 * several call sites here feed request-derived paths.
 *
 * Twins live in `@guren/cli` (`src/utils.ts`, `trimSlashes`) and
 * `@guren/plugin-cloudflare` (`src/storage/R2Driver.ts`, both functions);
 * neither package can import this module, so the lines are duplicated by
 * convention.
 */

export function trimTrailingSlashes(value: string): string {
  let end = value.length
  while (end > 0 && value[end - 1] === '/') end--
  return value.slice(0, end)
}

export function trimSlashes(value: string): string {
  let start = 0
  let end = value.length
  while (start < end && value[start] === '/') start++
  while (end > start && value[end - 1] === '/') end--
  return value.slice(start, end)
}
