import { describe, expect, it } from 'bun:test'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureGurenUiTokens } from '../src/guren-css'

const repoRoot = join(import.meta.dir, '../../..')

const BLUEPRINT = 'packages/create-app/templates/default/resources/css/guren.css'

const TOKEN_SHEETS = [
  'examples/agents/resources/css/guren.css',
  'packages/cli/templates/scaffold/guren-ui/resources/css/guren.css',
  BLUEPRINT,
]

/** Tracked, so an untracked scratch copy is not a failure and node_modules is
    never walked. */
function trackedTokenSheets(): string[] {
  const git = Bun.spawnSync(['git', 'ls-files', '-z', '--', '*resources/css/guren.css'], {
    cwd: repoRoot,
  })
  if (git.exitCode !== 0) {
    throw new Error(`git ls-files exited ${git.exitCode}: ${git.stderr.toString().trim()}`)
  }
  return git.stdout.toString().split('\0').filter(Boolean).sort()
}

/**
 * The token sheet ships in the create-app template, is written into older apps
 * by ensureGurenUiTokens, and is vendored into examples/agents — which no
 * command maintains, so it drifts silently. The copies must stay
 * byte-identical, or an app's tokens depend on which command wrote the file.
 * Upstream is gurenjs/guren-ui, and lands here by hand.
 */
it('every guren.css copy matches the create-app template copy', async () => {
  // Derived, then pinned: a fourth copy has to be added here deliberately, and
  // a listing that came back empty cannot pass the comparison below vacuously.
  const paths = trackedTokenSheets()
  expect(paths).toEqual(TOKEN_SHEETS)

  const blueprint = await readFile(join(repoRoot, BLUEPRINT), 'utf8')
  for (const path of paths) {
    expect(await readFile(join(repoRoot, path), 'utf8')).toBe(blueprint)
  }
})

async function makeApp(appCss?: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'guren-css-'))
  await mkdir(join(root, 'resources/css'), { recursive: true })
  if (appCss !== undefined) {
    await writeFile(join(root, 'resources/css/app.css'), appCss, 'utf8')
  }
  return root
}

describe('ensureGurenUiTokens', () => {
  it('writes guren.css and adds the app.css import once', async () => {
    const root = await makeApp("@import 'tailwindcss';\n")

    await ensureGurenUiTokens(root)

    const tokens = await readFile(join(root, 'resources/css/guren.css'), 'utf8')
    expect(tokens).toContain('--g-accent')
    const appCss = await readFile(join(root, 'resources/css/app.css'), 'utf8')
    expect(appCss).toBe("@import 'tailwindcss';\n@import './guren.css';\n")

    // Second run must not duplicate the import or clobber an edited sheet.
    await writeFile(join(root, 'resources/css/guren.css'), '/* user edited */\n', 'utf8')
    await ensureGurenUiTokens(root)
    expect(await readFile(join(root, 'resources/css/guren.css'), 'utf8')).toBe('/* user edited */\n')
    expect(await readFile(join(root, 'resources/css/app.css'), 'utf8')).toBe(
      "@import 'tailwindcss';\n@import './guren.css';\n",
    )
  })

  it('prepends the import when app.css has no @import lines', async () => {
    const root = await makeApp('body { margin: 0; }\n')

    await ensureGurenUiTokens(root)

    expect(await readFile(join(root, 'resources/css/app.css'), 'utf8')).toBe(
      "@import './guren.css';\nbody { margin: 0; }\n",
    )
  })

  it('keeps a multiline @import statement intact', async () => {
    const root = await makeApp("@import url(\n  'tailwindcss'\n);\nbody { margin: 0; }\n")

    await ensureGurenUiTokens(root)

    expect(await readFile(join(root, 'resources/css/app.css'), 'utf8')).toBe(
      "@import url(\n  'tailwindcss'\n);\n@import './guren.css';\nbody { margin: 0; }\n",
    )
  })

  it('recognizes the import without the ./ prefix and does not duplicate it', async () => {
    const before = "@import 'tailwindcss';\n@import 'guren.css';\n"
    const root = await makeApp(before)

    await ensureGurenUiTokens(root)

    expect(await readFile(join(root, 'resources/css/app.css'), 'utf8')).toBe(before)
  })

  it('treats a commented-out guren.css import as absent', async () => {
    const root = await makeApp("@import 'tailwindcss';\n/* @import './guren.css'; */\nbody { margin: 0; }\n")

    await ensureGurenUiTokens(root)

    expect(await readFile(join(root, 'resources/css/app.css'), 'utf8')).toBe(
      "@import 'tailwindcss';\n@import './guren.css';\n/* @import './guren.css'; */\nbody { margin: 0; }\n",
    )
  })

  it('leaves a missing app.css alone but still writes the tokens', async () => {
    const root = await makeApp()

    await ensureGurenUiTokens(root)

    expect(await readFile(join(root, 'resources/css/guren.css'), 'utf8')).toContain('--g-accent')
  })
})
