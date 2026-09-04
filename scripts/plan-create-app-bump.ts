/**
 * Add the `create-guren-app` bump a release needs, before `changeset version` runs.
 *
 * The scaffold's `@guren/*` ranges are generated from the workspace versions, so any
 * release moving one must republish the scaffolder; `assertCreateAppRepublishes` in
 * `sync-template-deps.ts` stays as the backstop but only sees a rewritten range, and
 * a drizzle pin is synced in the ordinary PR that moved it, so neither half covers it.
 * Writes a changeset rather than editing a version, so the bump appears in the
 * release PR diff and the changelog. Every path logs its decision.
 */
import { readFile, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { templateManifests } from '../packages/create-app/src/blueprints'
import { DEPENDENCY_GROUPS } from './sync-template-deps'
import { repoRoot } from './workspace-packages'

const SCAFFOLDER = 'create-guren-app'

/** The changeset this script owns; removed at the start of every run. */
export const MANAGED_CHANGESET = '.changeset/create-app-template-ranges.md'

/** One entry of `changeset status --output`; the rest of its fields go unread. */
interface PlannedRelease {
  name: string
  oldVersion: string
  newVersion: string
}

export interface ReleasePlan {
  releases: PlannedRelease[]
}

export type BumpDecision =
  | { bump: true; moving: string[] }
  | { bump: false; reason: 'no-release' | 'already-releasing' | 'templates-unaffected' }

/**
 * Changesets lists a package it pulled in but left alone as `type: "none"` with
 * its version unchanged; such an entry rewrites no range and uploads no tarball.
 */
function publishes(release: PlannedRelease): boolean {
  return release.newVersion !== release.oldVersion
}

/** Every `@guren/*` package whose version a template writes into its manifest. */
export async function packagesTemplatesDeclare(): Promise<Set<string>> {
  const declared = new Set<string>()

  for (const path of await templateManifests()) {
    const manifest = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
    for (const group of DEPENDENCY_GROUPS) {
      const dependencies = manifest[group] as Record<string, string> | undefined
      for (const dependency of Object.keys(dependencies ?? {})) {
        if (dependency.startsWith('@guren/')) {
          declared.add(dependency)
        }
      }
    }
  }

  return declared
}

/**
 * Does this release move a version a template declares?
 *
 * Must agree with whether `sync-template-deps` rewrites a range, since that is
 * what makes the scaffolder's tarball stale. Hence the shared `DEPENDENCY_GROUPS`
 * and a version comparison rather than a bare name match.
 */
export function planScaffolderBump(plan: ReleasePlan, declared: ReadonlySet<string>): BumpDecision {
  if (plan.releases.length === 0) {
    return { bump: false, reason: 'no-release' }
  }

  if (plan.releases.some((release) => release.name === SCAFFOLDER && publishes(release))) {
    return { bump: false, reason: 'already-releasing' }
  }

  const moving = plan.releases
    .filter((release) => publishes(release) && declared.has(release.name))
    .map((release) => release.name)

  return moving.length === 0 ? { bump: false, reason: 'templates-unaffected' } : { bump: true, moving }
}

export function renderChangeset(moving: readonly string[]): string {
  return [
    '---',
    `"${SCAFFOLDER}": patch`,
    '---',
    '',
    'Ship template dependency ranges for this release',
    '',
    "The scaffold's `@guren/*` ranges are generated from the workspace versions,",
    `and this release moves ${moving.map((name) => `\`${name}\``).join(', ')}.`,
    '`changeset publish` only uploads packages whose own version moved, so',
    'without this bump the updated ranges would sit in the repo and never reach',
    'anyone running `create-guren-app`.',
    '',
    'No behaviour change; the scaffolded app just resolves the versions released',
    'alongside it.',
    '',
  ].join('\n')
}

/**
 * Ask changesets what this release will publish.
 *
 * Spawns the workspace's own `changeset` rather than `bunx changeset`: the plan's
 * shape belongs to a particular `@changesets/cli`, and `bunx` quietly fetches a
 * different one from the registry when the workspace is not installed.
 */
async function readReleasePlan(): Promise<ReleasePlan> {
  const bin = join(repoRoot, 'node_modules/.bin/changeset')
  if (!(await Bun.file(bin).exists())) {
    throw new Error(`${bin} is missing. Run \`bun install\` before preparing a release.`)
  }

  const output = join(tmpdir(), `guren-release-plan-${process.pid}.json`)
  const status = Bun.spawnSync([bin, 'status', `--output=${output}`], {
    cwd: repoRoot,
    stdout: 'pipe',
    stderr: 'pipe',
  })

  if (!status.success) {
    throw new Error(
      `\`changeset status\` failed (exit ${status.exitCode}):\n${status.stderr.toString().trim()}`,
    )
  }

  try {
    return JSON.parse(await readFile(output, 'utf8')) as ReleasePlan
  } finally {
    await unlink(output).catch(() => {})
  }
}

async function main(): Promise<void> {
  // Before the plan is read: a bump left behind by an abandoned release would
  // otherwise read as `already-releasing`, and ship stale.
  await unlink(join(repoRoot, MANAGED_CHANGESET)).catch(() => {})

  const decision = planScaffolderBump(await readReleasePlan(), await packagesTemplatesDeclare())

  if (!decision.bump) {
    const reasons = {
      'no-release': 'No changesets are pending, so there is no release to prepare.',
      'already-releasing': `${SCAFFOLDER} is already in the release plan; nothing to add.`,
      'templates-unaffected': `No package the templates declare is releasing; ${SCAFFOLDER} does not need a bump.`,
    }
    console.log(reasons[decision.reason])
    return
  }

  await writeFile(join(repoRoot, MANAGED_CHANGESET), renderChangeset(decision.moving), 'utf8')
  console.log(`Wrote ${MANAGED_CHANGESET}: ${SCAFFOLDER} patch, because ${decision.moving.join(', ')} moved.`)
}

if (import.meta.path === Bun.main) {
  await main()
}
