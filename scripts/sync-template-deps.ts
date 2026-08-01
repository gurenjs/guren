/**
 * Keep the scaffold templates' `@guren/*` ranges pointed at the versions this
 * repository publishes.
 *
 * A template's `package.json` is the one manifest in the monorepo that resolves
 * against **npm** rather than the workspace, and nothing kept its ranges moving.
 * `changeset version` is what decides the new numbers, so the write mode runs
 * right after it (see the `version-packages` script). `--check` asserts the
 * same thing without writing and backs `audit:template-deps`, so a range that
 * falls behind fails CI on the PR that introduces it rather than on a user's
 * first `bunx create-guren-app`.
 */
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import process from 'node:process'
import { TEMPLATES_ROOT } from '../packages/create-app/src/blueprints'
import { collectPackages, repoRoot } from './workspace-packages'

const DEPENDENCY_GROUPS = ['dependencies', 'devDependencies', 'peerDependencies'] as const

interface Mismatch {
  /** Repo-relative path of the template manifest. */
  file: string
  group: (typeof DEPENDENCY_GROUPS)[number]
  dependency: string
  declared: string
  /** The range to write, or `null` when this workspace publishes no such package. */
  expected: string | null
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

/** Every template that ships a manifest — `blog` and `default-ssr` overlay one instead. */
async function templateManifests(): Promise<string[]> {
  const paths: string[] = []

  for (const entry of await readdir(TEMPLATES_ROOT, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue
    }
    const path = join(TEMPLATES_ROOT, entry.name, 'package.json')
    if (await Bun.file(path).exists()) {
      paths.push(path)
    }
  }

  return paths
}

interface TemplateManifest {
  path: string
  manifest: Record<string, unknown>
  mismatches: Mismatch[]
}

/** Read every template manifest and diff its `@guren/*` ranges against the workspace. */
async function collectMismatches(): Promise<TemplateManifest[]> {
  const ranges = await workspaceRanges()
  const templates: TemplateManifest[] = []

  for (const path of await templateManifests()) {
    const manifest = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
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
          mismatches.push({ file: relative(repoRoot, path), group, dependency, declared, expected })
        }
      }
    }

    templates.push({ path, manifest, mismatches })
  }

  return templates
}

function describe(mismatch: Mismatch): string {
  const expected = mismatch.expected ?? 'nothing — this workspace publishes no such package'
  return `  ${mismatch.file}: ${mismatch.dependency} declares ${mismatch.declared}, workspace publishes ${expected}`
}

async function check(): Promise<void> {
  const mismatches = (await collectMismatches()).flatMap((template) => template.mismatches)
  if (mismatches.length === 0) {
    console.log('Template dependency ranges match the workspace versions.')
    return
  }

  throw new Error(
    'Template dependency ranges have drifted from the versions this workspace publishes.\n' +
    `${mismatches.map(describe).join('\n')}\n` +
    'Run `bun run sync:template-deps`. These ranges resolve from npm, not from the\n' +
    'workspace, so a stale one scaffolds apps against a package line the templates\n' +
    'were never written for.',
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
 * Only checked under `--release`: outside `changeset version` there is no bump
 * to expect, and a maintainer repairing a hand-edited range would be told to
 * cut a release for nothing.
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
    console.log('Template dependency ranges already match the workspace versions.')
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
  }
}

if (import.meta.path === Bun.main) {
  await (process.argv.includes('--check')
    ? check()
    : write({ release: process.argv.includes('--release') }))
}
