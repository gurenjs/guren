/**
 * No regex: patterns like `/\/+$/` backtrack quadratically on long slash runs
 * mid-string, and several call sites feed request-derived paths.
 *
 * Twins that cannot import this module: `@guren/cli` (`src/utils.ts`) and
 * `@guren/plugin-cloudflare` (`src/storage/R2Driver.ts`) — keep them in step.
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
