import { describe, expect, it } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { relative } from 'node:path'
import { TEMPLATES_ROOT, templateManifests } from '../src/blueprints'

// The generators an app runs (make:validator, make:feature, plan:scaffold)
// write this import; read as text, since the CLI is not a dependency here.
const ZOD_IMPORT_SOURCE = new URL('../../cli/src/make-validator.ts', import.meta.url)

describe('template zod dependency', () => {
  it('is what the CLI generators import', async () => {
    const source = await readFile(ZOD_IMPORT_SOURCE, 'utf8')
    expect(source).toContain(`export const ZOD_IMPORT = "import { z } from 'zod'\\n"`)
  })

  // Undeclared, an app resolves zod only through @guren/cli's own dependency,
  // which neither its range nor its presence is promised to follow.
  it('is declared by every template manifest, at one range', async () => {
    const ranges = new Map<string, string | undefined>()
    for (const path of await templateManifests()) {
      const manifest = JSON.parse(await readFile(path, 'utf8')) as { dependencies?: Record<string, string> }
      ranges.set(relative(TEMPLATES_ROOT, path).replaceAll('\\', '/'), manifest.dependencies?.zod)
    }

    expect(ranges.size).toBeGreaterThan(1)
    for (const [file, range] of ranges) {
      expect({ file, range }).toEqual({ file, range: ranges.get('default/package.json') })
      expect(range).toBeDefined()
    }
  })
})
