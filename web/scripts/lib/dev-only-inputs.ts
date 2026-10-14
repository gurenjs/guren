/**
 * The deploy gate for development-only code (RFC 0032 M5): the Worker bundle
 * must take no input file from the development runtime error collector or the
 * CLI. Each group names the files it stands for; an empty group fails, so a
 * rename that leaves nothing to look for cannot pass as "nothing leaked".
 */
export interface DevOnlyGroup {
  what: string
  /** Absolute paths, or directory prefixes ending in `/`. */
  files: readonly string[]
}

export function judgeDevOnlyInputs(
  inputs: readonly string[],
  groups: readonly DevOnlyGroup[],
): { ok: boolean; lines: string[] } {
  const lines: string[] = []
  let ok = true
  for (const group of groups) {
    if (group.files.length === 0) {
      ok = false
      lines.push(`No files found for ${group.what}; the gate has nothing to compare against. Update web/scripts/check-dev-only-excluded.ts.`)
      continue
    }
    const leaked = inputs.filter((input) =>
      group.files.some((file) => (file.endsWith('/') ? input.startsWith(file) : input === file)),
    )
    if (leaked.length > 0) {
      ok = false
      lines.push(`The Worker bundle includes ${group.what}:`, ...leaked.map((input) => `  ${input}`))
    } else {
      lines.push(`Not in the Worker bundle: ${group.what}.`)
    }
  }
  return { ok, lines }
}
