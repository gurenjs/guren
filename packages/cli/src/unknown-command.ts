function bigrams(value: string): Set<string> {
  const pairs = new Set<string>()
  for (let index = 0; index < value.length - 1; index++) pairs.add(value.slice(index, index + 2))
  return pairs
}

/** Dice coefficient over bigrams, the rule the app's ConsoleKernel suggests commands by. */
function similarity(a: string, b: string): number {
  const left = bigrams(a)
  const right = bigrams(b)
  if (left.size === 0 || right.size === 0) return 0
  let shared = 0
  for (const pair of left) if (right.has(pair)) shared++
  return (2 * shared) / (left.size + right.size)
}

export function closestCommandNames(input: string, candidates: Iterable<string>, limit = 3): string[] {
  return [...candidates]
    .map((name) => ({ name, score: similarity(input, name) }))
    .filter(({ score }) => score > 0.5)
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
    .slice(0, limit)
    .map(({ name }) => name)
}

/**
 * The lines appended to citty's `Unknown command` error. Decided from names alone:
 * the CLI never boots the app, so it cannot know which console commands exist.
 */
export function unknownCommandHint(name: string, candidates: Iterable<string>, atRoot: boolean): string | undefined {
  const lines: string[] = []
  const close = closestCommandNames(name, candidates)
  if (close.length > 0) {
    lines.push(`Did you mean ${close.map((candidate) => `\`${candidate}\``).join(', ')}?`)
  }
  if (atRoot && name.includes(':')) {
    lines.push(
      `If your app registers \`${name}\` as a console command, run \`bun run console ${name}\`. If a plugin provides it, run guren from an app that has the plugin installed.`,
      '`bunx guren console` opens a REPL; it does not run app commands.',
    )
  }
  return lines.length > 0 ? lines.join('\n') : undefined
}
