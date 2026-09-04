import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { ParseCache, parseSourceFile, parserPluginCandidates } from '../src/parse-cache'
import { createTempWorkspace } from './helpers'

describe('parserPluginCandidates', () => {
  // The extension orders the attempts rather than deciding them, so a wrong
  // guess costs a retry instead of silently dropping the file.
  it('tries the extension-preferred variant first, but keeps the other', () => {
    const ts = parserPluginCandidates('a.ts')
    expect(ts[0]).not.toContain('jsx')
    expect(ts.some((plugins) => plugins.includes('jsx'))).toBe(true)

    const tsx = parserPluginCandidates('a.tsx')
    expect(tsx[0]).toContain('jsx')
    expect(tsx.some((plugins) => !plugins.includes('jsx'))).toBe(true)
  })

  it('covers both decorator dialects for every extension', () => {
    for (const path of [undefined, 'a.ts', 'a.tsx', 'a.js']) {
      const candidates = parserPluginCandidates(path)
      expect(candidates.some((plugins) => plugins.includes('decorators'))).toBe(true)
      expect(candidates.some((plugins) => plugins.includes('decorators-legacy'))).toBe(true)
    }
  })

  // Babel refuses both decorator plugins at once, so the order is a real cost:
  // legacy covers the leading form *and* constructor parameter decorators,
  // standard only the leading form.
  it('tries the legacy decorator dialect before the standard one', () => {
    for (const path of [undefined, 'a.ts', 'a.tsx']) {
      expect(parserPluginCandidates(path)[0]).toContain('decorators-legacy')
    }
  })
})

describe('parseSourceFile', () => {
  // The last two need *different* Babel dialects, which is why no single plugin
  // set covers them: `export @Dec class X` parses only under `decorators`,
  // parameter decorators only under `decorators-legacy`.
  const decoratorForms: Record<string, string> = {
    'decorator before export': '@Injectable()\nexport class A { m() { return 1 } }',
    'decorator after export': 'export @Injectable() class A { m() { return 1 } }',
    'decorated method': 'export class A { @log m() { return 1 } }',
    'decorated property': 'export class A { @observable value = 1 }',
    'auto-accessor field': 'export class A { @log accessor entries = [] }',
    'constructor parameter decorator': 'export class A { constructor(@inject("T") private x: string) {} }',
  }

  for (const [label, source] of Object.entries(decoratorForms)) {
    it(`parses a class using a ${label}`, () => {
      expect(parseSourceFile(source, 'a.ts')).not.toBeNull()
    })
  }

  // Neither plugin set parses both, so whichever the extension rule guessed
  // wrong used to be dropped. The retry covers both directions.
  it('parses angle-bracket casts and JSX regardless of extension', () => {
    expect(parseSourceFile('const x = <string>y', 'a.ts')).not.toBeNull()
    expect(parseSourceFile('const x = <string>y', 'a.js')).not.toBeNull()
    expect(parseSourceFile('export default () => <div />', 'a.tsx')).not.toBeNull()
    expect(parseSourceFile('export default () => <div />', 'a.ts')).not.toBeNull()
  })

  it('parses top-level await', () => {
    expect(parseSourceFile('const x = await f()', 'a.ts')).not.toBeNull()
  })

  it('returns null only when every dialect rejects the source', () => {
    expect(parseSourceFile('class {{{{', 'a.ts')).toBeNull()
  })

  // A permanent gap, not a missing candidate: the two decorator plugins are
  // mutually exclusive in Babel, so no plugin set accepts a file mixing forms
  // only one of them parses. Pinned so nobody "fixes" it by asserting success.
  it('remains unparseable when a file mixes forms only different dialects accept', () => {
    const source = `declare function dec(...args: unknown[]): unknown

export @dec class Controller {
  constructor(@dec private service: string) {}
}`
    expect(parseSourceFile(source, 'a.ts')).toBeNull()
  })

  // errorRecovery makes the *first* candidate succeed, so a param-decorated
  // model is recovered by the standard dialect rather than the legacy one, and
  // the static members audit reads have to survive that recovery.
  it('keeps static members readable when recovery short-circuits the dialect ladder', () => {
    const source = [
      'export class User {',
      '  static table = users',
      "  static hidden = ['password']",
      "  constructor(@inject('Repo') private repo: unknown) {}",
      '}',
    ].join('\n')

    for (const errorRecovery of [false, true]) {
      const ast = parseSourceFile(source, 'User.ts', { errorRecovery })
      expect(ast).not.toBeNull()
      const declaration = ast!.program.body.find((n) => n.type === 'ExportNamedDeclaration')
      const classBody =
        declaration?.type === 'ExportNamedDeclaration' && declaration.declaration?.type === 'ClassDeclaration'
          ? declaration.declaration.body.body
          : []
      const statics = classBody.flatMap((m) =>
        m.type === 'ClassProperty' && m.static && m.key.type === 'Identifier' ? [m.key.name] : [],
      )
      expect(statics).toEqual(['table', 'hidden'])
    }
  })

  // The case audit's model scan opts into errorRecovery for: an `override`
  // member is a hard parse error when the class has no extends clause.
  it('returns a partial AST for broken source when errorRecovery is requested', () => {
    const source = 'export class A { static override hidden = ["secret"] }'
    expect(parseSourceFile(source, 'a.ts')).toBeNull()
    expect(parseSourceFile(source, 'a.ts', { errorRecovery: true })).not.toBeNull()
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

      // The three accessors agree on the same underlying outcome.
      expect(await cache.source(join(dir, 'broken.ts'))).toBe('export class {{{{')
      expect(await cache.get(join(dir, 'broken.ts'))).toBeNull()
      expect(await cache.source(join(dir, 'nope.ts'))).toBeNull()
    } finally {
      await workspace.cleanup()
    }
  })

  // A caller asking only for source was fully served even on an unparsed file,
  // so it must not count as skipped in scan coverage; only get() records that.
  it('does not record a file as skipped when source() delivers it despite a parse failure', async () => {
    const workspace = await createTempWorkspace('guren-cli-parse-cache-source-not-skipped-')
    try {
      const dir = workspace.dir
      await writeFile(join(dir, 'broken.ts'), '/** @docs docs/example.md */\nexport class {{{{', 'utf8')

      const cache = new ParseCache()
      expect(await cache.source(join(dir, 'broken.ts'))).toContain('@docs docs/example.md')
      expect(cache.skippedFiles()).toEqual([])

      // get() on the same file needs an AST it can't have, so it does count.
      expect(await cache.get(join(dir, 'broken.ts'))).toBeNull()
      expect(cache.skippedFiles()).toEqual([{ filePath: join(dir, 'broken.ts'), reason: 'unparsed' }])
    } finally {
      await workspace.cleanup()
    }
  })

  it('records every requested file that yielded no AST', async () => {
    const workspace = await createTempWorkspace('guren-cli-parse-cache-skipped-')
    try {
      const dir = workspace.dir
      await writeFile(join(dir, 'good.ts'), 'export class A {}', 'utf8')
      await writeFile(join(dir, 'broken.ts'), 'export class {{{{', 'utf8')

      const cache = new ParseCache()
      expect(cache.skippedFiles()).toEqual([])

      await cache.get(join(dir, 'good.ts'))
      await cache.get(join(dir, 'broken.ts'))
      await cache.source(join(dir, 'missing.ts'))

      expect(cache.skippedFiles()).toEqual([
        { filePath: join(dir, 'broken.ts'), reason: 'unparsed' },
        { filePath: join(dir, 'missing.ts'), reason: 'unreadable' },
      ])
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
