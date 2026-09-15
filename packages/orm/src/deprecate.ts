// The ORM cannot import @guren/server's warnOnce (a dependency cycle), so it keeps its own set.
const warned = new Set<string>()

/**
 * @internal The deprecation policy's warning format
 * (`contributing/deprecation-policy.md`), once per `id:symbol` per process.
 */
export function warnDeprecated(
  id: string,
  symbol: string,
  replacement: string,
  versions: { since: string; removedIn: string },
): void {
  const key = `${id}:${symbol}`
  if (warned.has(key)) return
  warned.add(key)
  console.warn(
    `[guren] Deprecation (${id}): ${symbol}() is deprecated\n`
      + `  since ${versions.since}, will be removed in ${versions.removedIn}.\n`
      + `  ${replacement}`,
  )
}
