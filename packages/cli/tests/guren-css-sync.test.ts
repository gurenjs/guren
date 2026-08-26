import { describe, expect, it } from 'bun:test'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureGurenUiTokens } from '../src/guren-css'

const repoRoot = join(import.meta.dir, '../../..')

/**
 * The Guren UI token sheet exists in two places: create-guren-app ships it in
 * the default template, and `guren add auth` / `guren make:feature` write the
 * scaffold copy into apps that predate it (ensureGurenUiTokens). The two must
 * stay byte-identical — a drifted copy means an app gets different tokens
 * depending on which command created the file. Same policy as
 * scaffold-blog-sync.test.ts; upstream design decisions live in
 * gurenjs/guren-ui and land here by hand.
 */
it('the scaffold guren.css matches the create-app template copy', async () => {
  const scaffold = await readFile(
    join(repoRoot, 'packages/cli/templates/scaffold/guren-ui/resources/css/guren.css'),
    'utf8',
  )
  const blueprint = await readFile(
    join(repoRoot, 'packages/create-app/templates/default/resources/css/guren.css'),
    'utf8',
  )

  expect(scaffold).toBe(blueprint)
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
