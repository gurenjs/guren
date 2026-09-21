/**
 * What `guren gate` and `guren plan:verify` share when they spawn an app's own
 * scripts: reading `package.json` scripts, resolving a script or its fallback,
 * and shaping a subprocess's output into findings. The two commands classify a
 * missing script and a failure differently, so only the mechanics live here.
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { bunExecutable } from './subprocess'

/** Findings a stage may report before the rest collapses into one "and N more" line. */
export const MAX_FINDINGS = 40
export const OUTPUT_TAIL_LINES = 20

/** The app's `package.json` scripts, or none when the manifest cannot be read. */
export async function readScripts(cwd: string): Promise<Record<string, string>> {
  try {
    const manifest = JSON.parse(await readFile(join(cwd, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>
    }
    return manifest.scripts ?? {}
  } catch {
    return {}
  }
}

export interface ScriptCommand {
  label: string
  command: string[]
}

/** `bun run <script>` when the app declares it, else `fallback`, else `undefined`. */
export function resolveScriptCommand(
  scripts: Record<string, string>,
  script: string,
  fallback: [label: string, command: string[]] | null,
): ScriptCommand | undefined {
  if (scripts[script]) return { label: `bun run ${script}`, command: [bunExecutable(), 'run', script] }
  return fallback ? { label: fallback[0], command: fallback[1] } : undefined
}

export function nonEmptyLines(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.trim() !== '')
}

export function capFindings(findings: string[]): string[] {
  if (findings.length <= MAX_FINDINGS) return findings
  return [...findings.slice(0, MAX_FINDINGS), `... and ${findings.length - MAX_FINDINGS} more`]
}

/** The output lines matching `pattern`, or the tail of the output when none do. */
export function outputFindings(output: string, pattern: RegExp): string[] {
  const lines = nonEmptyLines(output)
  const matched = lines.filter((line) => pattern.test(line))
  return capFindings(matched.length > 0 ? matched : lines.slice(-OUTPUT_TAIL_LINES))
}
