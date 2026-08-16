/**
 * Keep the scaffold templates' dependency versions pointed at what this
 * repository publishes and depends on.
 *
 * A template's `package.json` is the one manifest in the monorepo that resolves
 * against **npm** rather than the workspace, and nothing kept its versions
 * moving. Two rules apply to it:
 *
 * - every `@guren/*` range follows the workspace version. `changeset version`
 *   is what decides the new numbers, so the write mode runs right after it (see
 *   the `version-packages` script).
 * - `drizzle-orm` and `drizzle-kit` follow the exact pin `packages/orm` depends
 *   on, by the same rule `guren upgrade` applies to an installed app — see
 *   `packages/cli/src/drizzle-pins.ts` for why a second copy is the hazard.
 *
 * `--check` asserts both without writing and backs `audit:template-deps`, so a
 * version that falls behind fails CI on the PR that introduces it rather than on
 * a user's first `bunx create-guren-app`.
 */
import { readFile, writeFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import process from 'node:process'
import { templateManifests } from '../packages/create-app/src/blueprints'
import {
  PIN_SOURCE,
  planDrizzlePins,
  type DependencyManifest,
  type DrizzlePinDeclineReason,
  type OrmManifest,
} from '../packages/cli/src/drizzle-pins'
import { collectPackages, repoRoot } from './workspace-packages'

/**
 * The groups this script rewrites a template's ranges in. Exported because
 * `plan-create-app-bump.ts` has to predict, before `changeset version` runs,
 * whether this script will rewrite anything — a group it read and this one did
 * not would be a release that rewrites a range and plans no scaffolder bump.
 *
 * Deliberately not the four-group list in `scripts/smoke/local-packages.ts`:
 * that one answers which packages a smoke must vendor, and a group there costs
 * nothing extra, while a group here would rewrite a range this script does not
 * own.
 */
export const DEPENDENCY_GROUPS = ['dependencies', 'devDependencies', 'peerDependencies'] as const

const ORM_MANIFEST = 'packages/orm/package.json'

interface Mismatch {
  /** Repo-relative path of the template manifest. */
  file: string
  group: (typeof DEPENDENCY_GROUPS)[number]
  dependency: string
  declared: string
  /** The version to write, or `null` when this workspace publishes no such package. */
  expected: string | null
  /** Where `expected` comes from, so the drift report says which rule was broken. */
  because: string
}

/** Map every publishable `@guren/*` package to the range a template should declare. */
async function workspaceRanges(): Promise<Map<string, string>> {
  const ranges = new Map<string, string>()

  for (const pkg of await collectPackages()) {
    if (!pkg.name.startsWith('@guren/') || !pkg.version || pkg.private) {
      continue
    }
    ranges.set(pkg.name, `^${pkg.version}`)
  }

  return ranges
}

/** `packages/orm`'s own manifest — the pin the templates' drizzle versions follow. */
async function ormManifest(): Promise<OrmManifest> {
  const path = join(repoRoot, ORM_MANIFEST)
  // Unlike an unreachable registry, a missing ORM manifest is not a condition to
  // work around: it means this is not the repository this script belongs to.
  const raw = await readFile(path, 'utf8').catch((cause: unknown) => {
    throw new Error(`Could not read ${ORM_MANIFEST}, which is where the templates' drizzle pins come from.`, { cause })
  })
  return JSON.parse(raw) as OrmManifest
}

/**
 * Does `<name>@<version>` exist on npm? Asked only about `drizzle-kit`, and only
 * when its pin has to move — the two drizzle packages have never shared numbers
 * on their stable lines, so the companion release cannot be assumed to exist.
 *
 * A 404 is an answer (leave the pin alone, say so); anything else is not, and
 * throwing says so — the planner turns that into a `companion-unverifiable`
 * decline rather than a crash, so an npm outage neither fails an unrelated PR
 * nor reads as "no drift".
 *
 * Memoized across *templates*: the pin comes from one ORM manifest, so both of
 * them ask about the same release. The planner dedupes within one manifest.
 */
const published = new Map<string, Promise<boolean>>()
function companionPublished(name: string, version: string): Promise<boolean> {
  const key = `${name}@${version}`
  let pending = published.get(key)
  if (!pending) {
    pending = fetch(`https://registry.npmjs.org/${name}/${version}`).then((response) => {
      if (response.status === 404) {
        return false
      }
      if (!response.ok) {
        throw new Error(`npm returned ${response.status} for ${key}; cannot tell whether that release exists.`)
      }
      return true
    })
    published.set(key, pending)
  }
  return pending
}

interface TemplateManifest {
  path: string
  manifest: Record<string, unknown>
  mismatches: Mismatch[]
}

/**
 * Drizzle refusals a maintainer can resolve in this repository, and which
 * therefore have to fail rather than pass with a warning — a template cannot
 * ship a specifier that names a location, and the whole rule stops enforcing
 * anything once `packages/orm` no longer names one exact version to follow.
 *
 * The other two refusals are about npm, not about this checkout: `drizzle-kit`
 * releases the ORM's pin ahead of, and a registry that will not answer. Failing
 * on those would leave the gate red with nothing to fix.
 */
const BLOCKING_DECLINES = new Set<DrizzlePinDeclineReason>(['location-specifier', 'no-exact-pin'])

/** Read every template manifest and diff its versions against this workspace. */
async function collectMismatches(): Promise<TemplateManifest[]> {
  const ranges = await workspaceRanges()
  const orm = await ormManifest()
  const templates: TemplateManifest[] = []
  const blocked: string[] = []

  for (const path of await templateManifests()) {
    const manifest = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
    const file = relative(repoRoot, path)
    const mismatches: Mismatch[] = []

    for (const group of DEPENDENCY_GROUPS) {
      const dependencies = manifest[group] as Record<string, string> | undefined
      if (!dependencies) {
        continue
      }

      for (const [dependency, declared] of Object.entries(dependencies)) {
        if (!dependency.startsWith('@guren/')) {
          continue
        }
        const expected = ranges.get(dependency) ?? null
        if (declared !== expected) {
          mismatches.push({
            file,
            group,
            dependency,
            declared,
            expected,
            because: expected
              ? `workspace publishes ${expected}`
              : 'this workspace publishes no such package',
          })
        }
      }
    }

    // The same rule `guren upgrade` runs against an installed app, with the
    // workspace's ORM manifest standing in for the published one.
    const drizzle = await planDrizzlePins(manifest as DependencyManifest, orm, {
      companionPublished,
      onDecline: ({ reason, message }) => {
        console.warn(`${file}: ${message}`)
        if (BLOCKING_DECLINES.has(reason)) {
          blocked.push(`  ${file}: ${message}`)
        }
      },
    })
    mismatches.push(
      ...drizzle.map((change) => ({
        file,
        group: change.field,
        dependency: change.name,
        declared: change.previousVersion,
        expected: change.nextVersion,
        because: `${ORM_MANIFEST} pins ${PIN_SOURCE} ${change.nextVersion}`,
      })),
    )

    templates.push({ path, manifest, mismatches })
  }

  // Thrown from here so neither mode can proceed: a refusal this script cannot
  // rewrite is drift it must not report as a match, and half-syncing a template
  // whose pins it could not read is worse than syncing none.
  if (blocked.length > 0) {
    throw new Error(
      'Template drizzle pins this script will not rewrite:\n' +
      `${blocked.join('\n')}\n` +
      'Fix them by hand. Templates are installed from npm, so a specifier naming a\n' +
      `location can never ship, and ${ORM_MANIFEST} must name one exact ${PIN_SOURCE}\n` +
      'version for the templates to have something to follow.',
    )
  }

  return templates
}

function describe(mismatch: Mismatch): string {
  return `  ${mismatch.file}: ${mismatch.dependency} declares ${mismatch.declared}, ${mismatch.because}`
}

async function check(): Promise<void> {
  const mismatches = (await collectMismatches()).flatMap((template) => template.mismatches)
  if (mismatches.length === 0) {
    console.log('Template dependency versions match the workspace.')
    return
  }

  throw new Error(
    'Template dependency versions have drifted from this workspace.\n' +
    `${mismatches.map(describe).join('\n')}\n` +
    'Run `bun run sync:template-deps`. These versions resolve from npm, not from the\n' +
    'workspace, so a stale @guren/* range scaffolds apps against a package line the\n' +
    'templates were never written for, and a stale drizzle pin installs a second copy\n' +
    'of the ORM beside the one @guren/orm brings.',
  )
}

/**
 * A rewritten template only reaches users inside a new `create-guren-app`
 * tarball, and `changeset publish` skips a package whose version did not move.
 * `create-guren-app` declares no `@guren/*` dependency, so changesets has no
 * edge to follow and will not bump it just because the ORM did — an ORM-only
 * changeset would rewrite the templates here and then publish nothing carrying
 * them, silently restoring the drift this script exists to prevent.
 *
 * Only an *error* under `--release`: outside `changeset version` there is no
 * bump to compare against, so a maintainer repairing a hand-edited version — or
 * following an ORM drizzle pin that moved in an ordinary PR — would be failed
 * for a release that is not theirs to cut. The same fact is printed as a
 * reminder on that path instead.
 */
async function assertCreateAppRepublishes(): Promise<void> {
  const manifestPath = 'packages/create-app/package.json'
  const committed = Bun.spawnSync(['git', 'show', `HEAD:${manifestPath}`], { cwd: repoRoot })
  if (!committed.success) {
    console.warn(`Could not read ${manifestPath} from git; skipping the create-guren-app release check.`)
    return
  }

  const previous = (JSON.parse(committed.stdout.toString()) as { version?: string }).version
  const current = (await Bun.file(join(repoRoot, manifestPath)).json() as { version?: string }).version

  if (previous === current) {
    throw new Error(
      `The templates changed but create-guren-app is still ${current}.\n` +
      'changeset publish only publishes packages whose version moved, so the new\n' +
      'ranges would never reach the registry. Add a create-guren-app bump to a\n' +
      'changeset, re-run `changeset version`, then run this script again.',
    )
  }
}

async function write(options: { release: boolean }): Promise<void> {
  const templates = await collectMismatches()
  const unpublishable = templates.flatMap((t) => t.mismatches).filter((m) => m.expected === null)

  // Validated before anything is written, so a bad manifest cannot leave half
  // the templates rewritten and half untouched.
  if (unpublishable.length > 0) {
    throw new Error(
      'Templates name @guren/* packages this workspace does not publish:\n' +
      unpublishable.map(describe).join('\n'),
    )
  }

  const changed = templates.filter((template) => template.mismatches.length > 0)
  if (changed.length === 0) {
    console.log('Template dependency versions already match the workspace.')
    return
  }

  for (const template of changed) {
    for (const mismatch of template.mismatches) {
      const group = template.manifest[mismatch.group] as Record<string, string>
      group[mismatch.dependency] = mismatch.expected as string
      console.log(`${mismatch.file}: ${mismatch.dependency} ${mismatch.declared} -> ${mismatch.expected}`)
    }
    // Templates are hand-edited files; keep the two-space, newline-terminated
    // shape the rest of them have so the diff is only the ranges.
    await writeFile(template.path, `${JSON.stringify(template.manifest, null, 2)}\n`, 'utf8')
  }

  if (options.release) {
    await assertCreateAppRepublishes()
    return
  }

  // Outside `changeset version` there is no bump to assert against, but the same
  // fact still holds: a drizzle pin that moves in an ordinary PR reaches users
  // only inside a new create-guren-app tarball.
  console.log(
    '\nThese templates ship inside create-guren-app. Add a create-guren-app bump to\n' +
    'your changeset, or the rewritten versions will not reach the registry.',
  )
}

if (import.meta.path === Bun.main) {
  await (process.argv.includes('--check')
    ? check()
    : write({ release: process.argv.includes('--release') }))
}
