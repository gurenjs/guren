import { describe, expect, it } from 'bun:test'
import { access, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { scaffoldAppBlueprint } from '../src/blueprints'
import { createTempWorkspace } from './helpers'

/**
 * The scaffolded document is built by InertiaEngine, which never reads
 * public/index.html — only a `setInertiaDocument({ head })` registration
 * reaches a browser tab. The blog blueprint overlays its own src/app.ts, so
 * each blueprint has to be checked where it actually registers the markup.
 */
const REGISTRATION_FILES = ['src/app.ts', 'config/inertia.ts']

async function findFaviconHref(appRoot: string): Promise<string | undefined> {
  for (const file of REGISTRATION_FILES) {
    let source: string
    try {
      source = await readFile(join(appRoot, file), 'utf8')
    } catch {
      continue
    }

    if (!source.includes('setInertiaDocument(')) {
      continue
    }

    const match = source.match(/<link rel="icon"[^>]*href="([^"]+)"/u)
    if (match) {
      return match[1]
    }
  }

  return undefined
}

describe.each(['default', 'blog', 'worker'])('%s blueprint favicon', (blueprint) => {
  it('registers a favicon link pointing at a file that ships in public/', async () => {
    const workspace = await createTempWorkspace(`guren-favicon-${blueprint}-`)

    try {
      const dest = join(workspace.dir, 'test-app')
      await scaffoldAppBlueprint({
        blueprint,
        destination: dest,
        renderingMode: 'spa',
        database: 'sqlite',
      })

      const href = await findFaviconHref(dest)
      expect(href).toBeDefined()
      // Throws if the referenced asset is missing from the scaffolded public/.
      await access(join(dest, 'public', href!.replace(/^\//u, '')))
    } finally {
      await workspace.cleanup()
    }
  })
})
