import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { ParseCache, parseSourceFile, parserPluginsFor } from '../src/parse-cache'
import { createTempWorkspace } from './helpers'

describe('parserPluginsFor', () => {
  it('omits jsx for .ts and .mts so angle-bracket casts still parse', () => {
    expect(parserPluginsFor('a.ts')).not.toContain('jsx')
    expect(parserPluginsFor('a.mts')).not.toContain('jsx')
    expect(parseSourceFile('const x = <string>y', { filePath: 'a.ts' })).not.toBeNull()
  })

  it('enables jsx everywhere else', () => {
    for (const path of ['a.tsx', 'a.jsx', 'a.js', 'a.mjs']) {
      expect(parserPluginsFor(path)).toContain('jsx')
    }
    expect(parseSourceFile('const el = <div />', { filePath: 'a.tsx' })).not.toBeNull()
  })

  it('enables decorator plugins for every extension', () => {
    for (const path of [undefined, 'a.ts', 'a.tsx', 'a.js']) {
      expect(parserPluginsFor(path)).toContain('decorators')
      expect(parserPluginsFor(path)).toContain('decoratorAutoAccessors')
    }
  })
})

describe('parseSourceFile', () => {
  // Each of these threw "This experimental syntax requires enabling one of the
  // following parser plugin(s)" before the decorator plugins were enabled,
  // which callers could not distinguish from a genuinely broken file.
  const decoratorForms: Record<string, string> = {
    'decorator before export': '@Injectable()\nexport class A { m() { return 1 } }',
    'decorator after export': 'export @Injectable() class A { m() { return 1 } }',
    'decorated method': 'export class A { @log m() { return 1 } }',
    'decorated property': 'export class A { @observable value = 1 }',
    'auto-accessor field': 'export class A { @log accessor entries = [] }',
  }

  for (const [label, source] of Object.entries(decoratorForms)) {
    it(`parses a class using a ${label}`, () => {
      expect(parseSourceFile(source, { filePath: 'a.ts' })).not.toBeNull()
    })
  }

  it('parses top-level await', () => {
    expect(parseSourceFile('const x = await f()', { filePath: 'a.ts' })).not.toBeNull()
  })

  it('returns null for genuinely broken source', () => {
    expect(parseSourceFile('class {{{{', { filePath: 'a.ts' })).toBeNull()
  })

  it('forces jsx on when no path is available but jsx is requested', () => {
    expect(parseSourceFile('const el = <div />')).toBeNull()
    expect(parseSourceFile('const el = <div />', { jsx: true })).not.toBeNull()
  })
})

describe('ParseCache', () => {
  it('distinguishes parsed, unparsed, and unreadable files', async () => {
    const workspace = await createTempWorkspace('guren-cli-parse-cache-')
    try {
      const dir = workspace.dir
      await writeFile(join(dir, 'good.ts'), '@Injectable()\nexport class A {}', 'utf8')
      await writeFile(join(dir, 'broken.ts'), 'export class {{{{', 'utf8')
      await mkdir(join(dir, 'a-directory'), { recursive: true })

      const cache = new ParseCache()

      const good = await cache.read(join(dir, 'good.ts'))
      expect(good.status).toBe('parsed')

      const broken = await cache.read(join(dir, 'broken.ts'))
      expect(broken.status).toBe('unparsed')
      // The source survives a parse failure — that's what lets the regex-only
      // scans keep working on a file the parser rejected.
      expect(broken.status === 'unparsed' && broken.source).toBe('export class {{{{')

      expect((await cache.read(join(dir, 'nope.ts'))).status).toBe('unreadable')
      expect((await cache.read(join(dir, 'a-directory'))).status).toBe('unreadable')
    } finally {
      await workspace.cleanup()
    }
  })

  it('exposes source for unparsed files and null only when unreadable', async () => {
    const workspace = await createTempWorkspace('guren-cli-parse-cache-source-')
    try {
      const dir = workspace.dir
      await writeFile(join(dir, 'broken.ts'), 'export class {{{{', 'utf8')

      const cache = new ParseCache()
      expect(await cache.source(join(dir, 'broken.ts'))).toBe('export class {{{{')
      expect(await cache.get(join(dir, 'broken.ts'))).toBeNull()
      expect(await cache.source(join(dir, 'missing.ts'))).toBeNull()
    } finally {
      await workspace.cleanup()
    }
  })

  it('reads each file once across repeated lookups', async () => {
    const workspace = await createTempWorkspace('guren-cli-parse-cache-reuse-')
    try {
      const file = join(workspace.dir, 'a.ts')
      await writeFile(file, 'export class A {}', 'utf8')

      const cache = new ParseCache()
      const [first, second] = await Promise.all([cache.read(file), cache.read(file)])
      expect(first).toBe(second)

      // A later rewrite is not observed — the cache is per-invocation by design.
      await writeFile(file, 'export class B {}', 'utf8')
      expect(await cache.source(file)).toBe('export class A {}')
    } finally {
      await workspace.cleanup()
    }
  })
})
