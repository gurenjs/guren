import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { cachedFileProbe } from '../src/import-resolution'
import { scanImports } from '../src/import-scan'
import { ParseCache } from '../src/parse-cache'

describe('scanImports', () => {
  let root: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'guren-import-scan-'))
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  async function write(files: Record<string, string>): Promise<string[]> {
    for (const [path, contents] of Object.entries(files)) {
      await mkdir(dirname(join(root, path)), { recursive: true })
      await writeFile(join(root, path), contents, 'utf8')
    }
    return Object.keys(files).map((path) => join(root, path))
  }

  const scan = (files: string[]) => scanImports(root, new ParseCache(), files, cachedFileProbe())

  it('reads runtime package and file imports, skipping type-only ones and runtime builtins', async () => {
    const files = await write({
      'app/Services/Mailer.ts': [
        "import { z } from 'zod'",
        "import type { Hono } from 'hono'",
        "import { format } from 'date-fns/format'",
        "import { readFile } from 'node:fs/promises'",
        "export { helper } from './helper'",
        "export type { Shape } from './shape'",
        "const lazy = () => import('@scope/lazy/sub')",
      ].join('\n'),
      'app/Services/helper.ts': 'export const helper = 1',
      'app/Services/shape.ts': 'export type Shape = {}',
    })

    const { files: scanned, reasons } = await scan(files)

    expect(reasons).toEqual([])
    expect(scanned.get('app/Services/Mailer.ts')).toEqual({
      packages: [
        { name: 'zod', specifier: 'zod', line: 1 },
        { name: 'date-fns', specifier: 'date-fns/format', line: 3 },
        { name: '@scope/lazy', specifier: '@scope/lazy/sub', line: 7 },
      ],
      files: ['app/Services/helper.ts'],
    })
  })

  it('expands a literal import.meta.glob and the scaffolded page resolver to the files they match', async () => {
    const files = await write({
      'resources/js/app.tsx': [
        "import { pageManifest } from '@/.guren/pages.gen'",
        "const pages = import.meta.glob!('./pages/**/*.tsx')",
        'const resolve = (name: string) => import(pageManifest[name as keyof typeof pageManifest] ?? `./pages/${name}.tsx`)',
      ].join('\n'),
      'resources/js/pages/posts/Index.tsx': 'export default function Index() { return null }',
      'resources/js/components/Card.tsx': 'export const Card = 1',
    })

    const { files: scanned, reasons } = await scan(files)

    expect(reasons.map((reason) => reason.code)).toEqual(['unresolved-import'])
    expect(scanned.get('resources/js/app.tsx')?.files).toEqual(['resources/js/pages/posts/Index.tsx'])
  })

  it('reads a root-absolute glob from the project root and reports one that matches nothing', async () => {
    const files = await write({
      'resources/js/app.tsx': "const widgets = import.meta.glob('/resources/js/widgets/*.tsx')\nconst none = import.meta.glob('./nothing/*.tsx')",
      'resources/js/widgets/Chart.tsx': 'export const Chart = 1',
    })

    const { files: scanned, reasons } = await scan(files)

    expect(scanned.get('resources/js/app.tsx')?.files).toEqual(['resources/js/widgets/Chart.tsx'])
    expect(reasons.map((reason) => reason.message)).toEqual(['resources/js/app.tsx globs ./nothing/*.tsx, which matches no file this reader scans.'])
  })

  it('reports an import of a code file outside the scan, but not of a stylesheet', async () => {
    const files = await write({
      'app/main.ts': "import './build/generated'\nimport '../resources/css/app.css'",
      'resources/css/app.css': 'body {}',
    })
    await mkdir(join(root, 'app/build'), { recursive: true })
    await writeFile(join(root, 'app/build/generated.ts'), "export const x = 1", 'utf8')

    const { reasons } = await scan(files.filter((file) => file.endsWith('.ts')))

    expect(reasons.map((reason) => reason.code)).toEqual(['outside-scan'])
  })

  it('reports every construct it cannot follow instead of reading the file as importing nothing', async () => {
    const files = await write({
      'app/loader.ts': [
        'const name = process.env.MODULE ?? "x"',
        'await import(name)',
        "const legacy = require('legacy')",
        'const parts = import.meta.glob(name)',
        "new Worker('./worker.ts')",
        "import missing from './missing'",
      ].join('\n'),
      'app/broken.ts': 'export const = 1',
    })

    const { reasons } = await scan(files)

    expect(reasons.map((reason) => reason.code).sort()).toEqual([
      'unfollowed-import',
      'unfollowed-import',
      'unfollowed-import',
      'unfollowed-import',
      'unparsed',
      'unresolved-import',
    ])
    expect(reasons.find((reason) => reason.code === 'unresolved-import')?.message).toBe('app/loader.ts:6 imports ./missing, which does not resolve to a file.')
  })
})
