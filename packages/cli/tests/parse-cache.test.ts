import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { ParseCache, parseSourceFile, parserPluginCandidates } from '../src/parse-cache'
import { createTempWorkspace } from './helpers'

describe('parserPluginCandidates', () => {
  // The extension orders the attempts rather than deciding them — every
  // candidate list covers both JSX settings and both decorator dialects, so a
  // wrong guess costs a retry instead of silently dropping the file.
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

  // The two decorator plugins can't be enabled together (Babel throws a config
  // error), so whichever goes first is a real cost, not a free choice: legacy
  // covers both the leading-decorator form and constructor parameter
  // decorators, standard alone covers only the leading form. Legacy first
  // makes the DI-flavoured case this fix targets cost one parse instead of two.
  it('tries the legacy decorator dialect before the standard one', () => {
    for (const path of [undefined, 'a.ts', 'a.tsx']) {
      expect(parserPluginCandidates(path)[0]).toContain('decorators-legacy')
    }
  })
})

describe('parseSourceFile', () => {
  // Every one of these threw "This experimental syntax requires enabling one of
  // the following parser plugin(s)" before the decorator plugins were enabled,
  // which callers could not distinguish from a genuinely broken file. Note the
  // last two need *different* Babel dialects, which is why a single plugin set
  // could not fix this: `export @Dec class X` parses only under `decorators`,
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

  // A known, permanent gap rather than a missing candidate: the two decorator
  // plugins are mutually exclusive in Babel, so no plugin set can accept a
  // file that mixes the one form only `decorators` parses (a trailing
  // `export @Dec class X`) with the one form only `decorators-legacy` parses
  // (a constructor parameter decorator). Documented in the DECORATOR_PLUGINS
  // comment; this test exists so a future change to the candidate list
  // doesn't accidentally "fix" this by asserting it should now succeed.
  it('remains unparseable when a file mixes forms only different dialects accept', () => {
    const source = `declare function dec(...args: unknown[]): unknown

export @dec class Controller {
  constructor(@dec private service: string) {}
}`
    expect(parseSourceFile(source, 'a.ts')).toBeNull()
  })

  // errorRecovery makes the *first* candidate succeed where it would otherwise
  // have thrown, so a param-decorated model is now recovered by the standard
  // dialect rather than falling through to the legacy one. Audit reads static
  // members off that AST, so they have to survive the recovery.
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

  // source() delivers value for an unparsed file (that's the whole point of
  // the regex-only scans it exists for), so a caller asking only for source
  // was fully served — it must not show up in scan-coverage as "skipped and
  // not checked" when nothing it needed went unmet. Only get() (which really
  // did fail to produce what it was asked for) records the unparsed case.
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
      // Nothing requested yet, so nothing to report.
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
