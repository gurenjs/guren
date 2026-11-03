/**
 * The release-age gate in an app's `bunfig.toml` (RFC 0039 §2): the block the
 * scaffold templates ship, which `scripts/template-cooldown.ts` renders for them,
 * and the reading `guren doctor` judges and `guren upgrade` extends. Bun ignores a
 * scope pattern in `minimumReleaseAgeExcludes`, so each `@guren` package an app has
 * must be listed by name, or a release of it younger than the gate fails to install.
 */
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { readJsonIfExists } from './discovery'

export const RELEASE_AGE_SECONDS = 259_200
export const BUNFIG_FILE = 'bunfig.toml'

const RELEASE_AGE_DAYS = RELEASE_AGE_SECONDS / 86_400
const MANIFEST_FIELDS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'] as const
const EXCLUDES_ARRAY = /^minimumReleaseAgeExcludes = \[\n(?:[^\n\]]*\n)*?\]$/mu

/** The scaffold's block, byte for byte; the templates' `bunfig.toml` is exactly this. */
export function renderReleaseAgeBunfig(excludes: readonly string[]): string {
  const entries = excludes.map((name) => `  ${JSON.stringify(name)},`).join('\n')
  return `# Bun skips package versions published less than minimumReleaseAge seconds
# ago (${RELEASE_AGE_DAYS} days), so a compromised release has time to be found and pulled
# before an install here picks it up. To take a fix that is newer than that, add
# its exact version to the list below, for example "some-package@1.2.4".
# The @guren packages are listed one by one because Bun does not read "@guren/*",
# and a Guren upgrade asks for releases newer than the gate allows.
[install]
minimumReleaseAge = ${RELEASE_AGE_SECONDS}
minimumReleaseAgeExcludes = [
${entries}
]
`
}

export type ReleaseAgeReading =
  | { kind: 'missing-file' }
  | { kind: 'unreadable'; reason: string }
  | { kind: 'no-install-table' }
  | { kind: 'no-gate' }
  | { kind: 'off' }
  | { kind: 'on'; seconds: number; excludes: string[] }

/** `text` is the file's contents, or undefined when there is none. */
export function readReleaseAge(text: string | undefined): ReleaseAgeReading {
  if (text === undefined) return { kind: 'missing-file' }
  let parsed: unknown
  try {
    parsed = Bun.TOML.parse(text)
  } catch (error) {
    return { kind: 'unreadable', reason: error instanceof Error ? error.message : String(error) }
  }
  const install = (parsed as { install?: unknown }).install
  if (install === undefined) return { kind: 'no-install-table' }
  if (typeof install !== 'object' || install === null) return { kind: 'unreadable', reason: '`install` is not a table' }
  const { minimumReleaseAge, minimumReleaseAgeExcludes } = install as Record<string, unknown>
  if (minimumReleaseAge === undefined) return { kind: 'no-gate' }
  if (typeof minimumReleaseAge !== 'number' || !Number.isFinite(minimumReleaseAge) || minimumReleaseAge < 0) {
    return { kind: 'unreadable', reason: '`minimumReleaseAge` is not a number of seconds' }
  }
  if (minimumReleaseAge === 0) return { kind: 'off' }
  if (minimumReleaseAgeExcludes !== undefined && (!Array.isArray(minimumReleaseAgeExcludes) || minimumReleaseAgeExcludes.some((entry) => typeof entry !== 'string'))) {
    return { kind: 'unreadable', reason: '`minimumReleaseAgeExcludes` is not a list of package names' }
  }
  return { kind: 'on', seconds: minimumReleaseAge, excludes: (minimumReleaseAgeExcludes ?? []) as string[] }
}

/** A `name@version` entry exempts that version only, so it does not count as the package. */
export function missingExclusions(excludes: readonly string[], packages: readonly string[]): string[] {
  const listed = new Set(excludes)
  return packages.filter((name) => !listed.has(name))
}

/**
 * The text with `names` added to a `minimumReleaseAgeExcludes` written one entry
 * per line, as the scaffold writes it; null for any other shape, which is left to
 * the author rather than edited by pattern.
 */
export function addExclusions(text: string, names: readonly string[]): string | null {
  const match = EXCLUDES_ARRAY.exec(text)
  if (!match || text.match(new RegExp(EXCLUDES_ARRAY.source, 'gmu'))!.length !== 1) return null
  const closing = match.index + match[0].length - 1
  const added = names.map((name) => `  ${JSON.stringify(name)},\n`).join('')
  return `${text.slice(0, closing)}${added}${text.slice(closing)}`
}

/** The `@guren` packages an app declares in its manifest or has under `node_modules/@guren`. */
export async function appGurenPackages(cwd: string): Promise<string[]> {
  const names = new Set<string>()
  const manifest = (await readJsonIfExists<Partial<Record<(typeof MANIFEST_FIELDS)[number], Record<string, string>>>>(cwd, 'package.json')).value
  for (const field of MANIFEST_FIELDS) {
    for (const name of Object.keys(manifest?.[field] ?? {})) {
      if (name.startsWith('@guren/')) names.add(name)
    }
  }
  const installed = await readdir(join(cwd, 'node_modules', '@guren'), { withFileTypes: true }).catch(() => [])
  for (const entry of installed) {
    if (entry.isDirectory() || entry.isSymbolicLink()) names.add(`@guren/${entry.name}`)
  }
  return [...names].sort((a, b) => a.localeCompare(b))
}
