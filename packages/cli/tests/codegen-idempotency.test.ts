import { describe, expect, it } from 'bun:test'
import { mkdir, stat, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createTempWorkspace } from './helpers'
import { generatePageTypes } from '../src/pages-types'
import { generateRouteTypes } from '../src/routes-types'
import { writeGeneratedFile } from '../src/utils'

// Codegen re-runs on every save under resources/js/pages/,
// app/Http/Resources/, and routes/web.ts (the Vite plugin's
// handleHotUpdate). Controllers import the results, so rewriting
// byte-identical output bumps the mtime of files a backend watcher is
// watching — a frontend-only edit would restart the server (and with it the
// in-process Vite dev server, killing the browser's HMR connection).
//
// Comparing timestamps across two writes is not enough on its own: both can
// land inside one filesystem timestamp tick and compare equal even when the
// write really happened. Each test below back-dates the artifact to a known
// mtime first, so an unchanged timestamp proves no write occurred, and every
// no-op case is paired with a control asserting the mtime does move when the
// output would actually change.

const BACKDATED_SECONDS = 1000
const BACKDATED_MS = BACKDATED_SECONDS * 1000

async function backdate(path: string): Promise<void> {
  await utimes(path, BACKDATED_SECONDS, BACKDATED_SECONDS)
}

async function mtimeMs(path: string): Promise<number> {
  return (await stat(path)).mtimeMs
}

async function writePage(dir: string, name: string, body: string): Promise<void> {
  await mkdir(join(dir, 'resources/js/pages'), { recursive: true })
  await writeFile(join(dir, `resources/js/pages/${name}`), body, 'utf8')
}

const ROUTES_FILE = `import type { Router } from '@guren/core'

export function registerWebRoutes(router: Router): void {
  router.get('/posts', () => new Response('ok')).name('posts.index')
}
`

describe('codegen write idempotency', () => {
  it('leaves pages.gen.ts untouched when the regenerated content is identical', async () => {
    const workspace = await createTempWorkspace('guren-cli-idempotent-pages-')
    try {
      await writePage(workspace.dir, 'Home.tsx', 'export default function Home() { return null }\n')

      const { outputPath } = await generatePageTypes({
        appRoot: workspace.dir,
        extractProps: false,
        force: true,
      })
      await backdate(outputPath)

      await generatePageTypes({ appRoot: workspace.dir, extractProps: false, force: true })

      expect(await mtimeMs(outputPath)).toBe(BACKDATED_MS)
    } finally {
      await workspace.cleanup()
    }
  })

  it('rewrites pages.gen.ts when a page is added', async () => {
    const workspace = await createTempWorkspace('guren-cli-idempotent-pages-changed-')
    try {
      await writePage(workspace.dir, 'Home.tsx', 'export default function Home() { return null }\n')

      const { outputPath } = await generatePageTypes({
        appRoot: workspace.dir,
        extractProps: false,
        force: true,
      })
      await backdate(outputPath)

      await writePage(workspace.dir, 'About.tsx', 'export default function About() { return null }\n')
      await generatePageTypes({ appRoot: workspace.dir, extractProps: false, force: true })

      expect(await mtimeMs(outputPath)).toBeGreaterThan(BACKDATED_MS)
    } finally {
      await workspace.cleanup()
    }
  })

  it('leaves routes.gen.ts and routes.d.ts untouched when the regenerated content is identical', async () => {
    const workspace = await createTempWorkspace('guren-cli-idempotent-routes-')
    try {
      await mkdir(join(workspace.dir, 'routes'), { recursive: true })
      await writeFile(join(workspace.dir, 'routes/web.ts'), ROUTES_FILE, 'utf8')

      const { outputPath, runtimeOutputPath } = await generateRouteTypes({
        appRoot: workspace.dir,
        force: true,
      })
      await backdate(outputPath)
      await backdate(runtimeOutputPath)

      await generateRouteTypes({ appRoot: workspace.dir, force: true })

      expect(await mtimeMs(outputPath)).toBe(BACKDATED_MS)
      expect(await mtimeMs(runtimeOutputPath)).toBe(BACKDATED_MS)
    } finally {
      await workspace.cleanup()
    }
  })

  // The route fixture can't be edited between two runs the way the pages
  // fixture can: `loadRouteDefinitions` imports routes/web.ts, and the module
  // cache hands back the first version for the rest of the process (the
  // cache-busting query it appends is inert on Bun). Staling the *output*
  // exercises the same branch — regeneration must still overwrite content
  // that differs from what it produces.
  it('rewrites route artifacts whose content differs from the regenerated output', async () => {
    const workspace = await createTempWorkspace('guren-cli-idempotent-routes-changed-')
    try {
      await mkdir(join(workspace.dir, 'routes'), { recursive: true })
      await writeFile(join(workspace.dir, 'routes/web.ts'), ROUTES_FILE, 'utf8')

      const { outputPath, runtimeOutputPath } = await generateRouteTypes({
        appRoot: workspace.dir,
        force: true,
      })

      for (const path of [outputPath, runtimeOutputPath]) {
        await writeFile(path, '// stale generated content\n', 'utf8')
        await backdate(path)
      }

      await generateRouteTypes({ appRoot: workspace.dir, force: true })

      for (const path of [outputPath, runtimeOutputPath]) {
        expect(await mtimeMs(path)).toBeGreaterThan(BACKDATED_MS)
        expect(await Bun.file(path).text()).not.toContain('stale generated content')
      }
    } finally {
      await workspace.cleanup()
    }
  })
})

describe('writeGeneratedFile', () => {
  it('creates the file (and its directory) when it does not exist', async () => {
    const workspace = await createTempWorkspace('guren-cli-write-generated-new-')
    try {
      const path = await writeGeneratedFile('.guren/example.gen.ts', 'export const a = 1\n')

      expect(await Bun.file(path).text()).toBe('export const a = 1\n')
    } finally {
      await workspace.cleanup()
    }
  })

  it('still refuses to overwrite differing content without force', async () => {
    const workspace = await createTempWorkspace('guren-cli-write-generated-guard-')
    try {
      await mkdir(join(workspace.dir, '.guren'), { recursive: true })
      await writeFile(join(workspace.dir, '.guren/example.gen.ts'), '// stale\n', 'utf8')

      await expect(
        writeGeneratedFile('.guren/example.gen.ts', 'export const a = 1\n'),
      ).rejects.toThrow(/already exists/)
    } finally {
      await workspace.cleanup()
    }
  })

  it('accepts identical content without force, since that is not a clobber', async () => {
    const workspace = await createTempWorkspace('guren-cli-write-generated-identical-')
    try {
      const contents = 'export const a = 1\n'
      await mkdir(join(workspace.dir, '.guren'), { recursive: true })
      await writeFile(join(workspace.dir, '.guren/example.gen.ts'), contents, 'utf8')
      await backdate(join(workspace.dir, '.guren/example.gen.ts'))

      const path = await writeGeneratedFile('.guren/example.gen.ts', contents)

      expect(await Bun.file(path).text()).toBe(contents)
      expect(await mtimeMs(path)).toBe(BACKDATED_MS)
    } finally {
      await workspace.cleanup()
    }
  })
})
