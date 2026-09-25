import { describe, expect, it } from 'bun:test'
import { existsSync } from 'node:fs'
import { readFile, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createTempRoot, runCliBinCaptured, writeWorkspaceFiles } from './helpers'

async function withApp(run: (app: string, caller: string) => Promise<void>) {
  const root = await createTempRoot('guren-codegen-command-')
  try {
    const app = join(root, 'app')
    await writeWorkspaceFiles(app, {
      'resources/js/pages/Home.tsx': 'export default function Home() { return null }\n',
      'routes/custom.ts': `import type { Router } from '@guren/core'
export function registerWebRoutes(router: Router) {
  router.get('/posts', () => new Response('ok')).name('posts.index')
}
`,
    })
    await run(app, root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

describe('codegen command boundary', () => {
  it('honours --app and custom outputs, overwrites stale output, and preserves identical files', async () => {
    await withApp(async (app, caller) => {
      const args = ['codegen', '--app', app, '--routes', 'routes/custom.ts', '--out', 'custom/routes.d.ts', '--pages-out', 'custom/pages.ts']
      const paths = ['custom/routes.d.ts', 'custom/pages.ts', '.guren/routes.gen.ts', '.guren/data.gen.ts', '.guren/channels.gen.ts', '.guren/api-client.gen.ts']
      const first = await runCliBinCaptured(args, caller)
      expect(first.exitCode).toBe(0)
      const contents = await Promise.all(paths.map(path => readFile(join(app, path), 'utf8')))
      expect(contents[0]).toContain('/posts')
      for (const path of paths) await utimes(join(app, path), 1000, 1000)
      expect((await runCliBinCaptured(args, caller)).exitCode).toBe(0)
      for (const path of paths) expect((await stat(join(app, path))).mtimeMs).toBe(1000000)
      await writeFile(join(app, paths[0]), '// stale\n')
      expect((await runCliBinCaptured(args, caller)).exitCode).toBe(0)
      expect(await readFile(join(app, paths[0]), 'utf8')).toBe(contents[0])
      expect(existsSync(join(caller, '.guren'))).toBe(false)
    })
  })

  it('generates independent artifacts before skipping a missing routes file', async () => {
    await withApp(async (app, caller) => {
      const result = await runCliBinCaptured(['codegen', '--app', app], caller)
      expect(result.exitCode).toBe(0)
      expect(result.stdout + result.stderr).toContain('Routes file routes/web.ts not found')
      expect(existsSync(join(app, '.guren/pages.gen.ts'))).toBe(true)
      expect(existsSync(join(app, '.guren/routes.gen.ts'))).toBe(false)
    })
  })

  it('retains progress output and fails when a later route import throws', async () => {
    await withApp(async (app, caller) => {
      await writeWorkspaceFiles(app, { 'routes/broken.ts': "throw new Error('route fixture failed')\n" })
      const result = await runCliBinCaptured(['codegen', '--app', app, '--routes', 'routes/broken.ts'], caller)
      expect(result.exitCode).toBe(1)
      expect(result.stdout + result.stderr).toContain('Page helpers generated')
      expect(result.stdout + result.stderr).toContain('route fixture failed')
      expect(result.stdout + result.stderr).not.toContain('API client generated')
    })
  })
})
