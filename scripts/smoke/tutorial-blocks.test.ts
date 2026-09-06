// The smoke executes whatever this grammar admits under a temp app root, so
// the refusals (paths that could escape it, attributes it would misread) are
// pinned here, along with the fence rules that keep a quoted example from
// being run.
import { describe, expect, test } from 'bun:test'
import {
  cdTarget,
  compareExecutableSequences,
  executableBlocks,
  parseScaffoldCommand,
  parseTutorialBlocks,
  validateFilePath,
} from './tutorial-blocks'

const fence = (info: string, body: string, ticks = '```'): string => `${ticks}${info}\n${body}\n${ticks}`

describe('parseTutorialBlocks', () => {
  test('classifies every attribute form', () => {
    const doc = [
      fence('bash run', 'bun test'),
      fence('bash run expect-fail', 'bun test tests/Tagline.test.ts'),
      fence('bash run background', 'bun run dev'),
      fence('bash run fallback', 'bunx guren add resource Tag'),
      fence('ts file=app/Models/Post.ts', 'export class Post {}'),
      fence('json file=lang/en/messages.json fallback', '{}'),
      fence('bash manual', 'fly deploy'),
      fence('ts manual', 'const a = 1'),
      fence('bash', 'ls'),
      fence('ts', 'const x = 1'),
    ].join('\n\n')

    const { blocks, issues } = parseTutorialBlocks(doc, 'ch.md')

    expect(issues).toEqual([])
    expect(blocks.map((block) => block.kind)).toEqual([
      'run', 'run', 'run', 'run', 'file', 'file', 'manual', 'manual', 'illustrative', 'illustrative',
    ])
    expect(blocks[1]).toMatchObject({ kind: 'run', mode: 'expect-fail', fallback: false })
    expect(blocks[2]).toMatchObject({ kind: 'run', mode: 'background' })
    expect(blocks[3]).toMatchObject({ kind: 'run', mode: 'normal', fallback: true })
    expect(blocks[4]).toMatchObject({ kind: 'file', path: 'app/Models/Post.ts', fallback: false, lang: 'ts' })
    expect(blocks[5]).toMatchObject({ kind: 'file', path: 'lang/en/messages.json', fallback: true })
    expect(blocks[6]).toMatchObject({ kind: 'manual', body: 'fly deploy' })
    expect(blocks[7]).toMatchObject({ kind: 'manual', lang: 'ts', body: 'const a = 1' })
    expect(blocks[0].line).toBe(1)
  })

  test('a four-backtick fence quoting three-backtick examples is one illustrative block', () => {
    const inner = `${fence('bash run', 'bunx guren make:policy Post')}\n\n${fence('ts file=x.ts', '// …')}`
    const doc = `Grammar:\n\n${fence('markdown', inner, '````')}\n\nThen:\n\n${fence('bash run', 'bun test')}`

    const { blocks, issues } = parseTutorialBlocks(doc)

    expect(issues).toEqual([])
    expect(blocks.map((block) => block.kind)).toEqual(['illustrative', 'run'])
    expect(blocks[0].body).toBe(inner)
  })

  test('reports the forms it will not run, each with its line', () => {
    const doc = [
      fence('ts run', 'x'),
      fence('bash run expect-fail background', 'x'),
      fence('bash run frobnicate', 'x'),
      fence('bash file=/etc/passwd', 'x'),
      fence('bash file=../escape.ts', 'x'),
      fence('bash manual fallback', 'x'),
      fence('bash step', 'x'),
      fence('bash run run', 'x'),
    ].join('\n')

    const { blocks, issues } = parseTutorialBlocks(doc, 'ch.md')

    expect(blocks.every((block) => block.kind === 'illustrative')).toBe(true)
    expect(issues.map((issue) => issue.line)).toEqual([1, 4, 7, 10, 13, 16, 19, 22])
    expect(issues[0].message).toContain('bash')
    expect(issues[1].message).toContain('expect-fail')
    expect(issues[3].message).toContain('relative')
    expect(issues[4].message).toContain('".."')
    expect(issues[7].message).toContain('duplicate')
  })

  test('an unterminated fence is an issue, not a silent swallow of the rest', () => {
    const { issues } = parseTutorialBlocks('```bash run\nbun test\n', 'ch.md')
    expect(issues).toEqual([{ file: 'ch.md', line: 1, message: 'unterminated fence' }])
  })
})

describe('validateFilePath', () => {
  test('accepts app-relative paths and refuses every escape', () => {
    expect(validateFilePath('app/Http/Controllers/PostController.ts')).toBeNull()
    expect(validateFilePath('.env')).toBeNull()
    expect(validateFilePath('')).not.toBeNull()
    expect(validateFilePath('/abs')).not.toBeNull()
    expect(validateFilePath('C:/abs')).not.toBeNull()
    expect(validateFilePath('a/../b')).not.toBeNull()
    expect(validateFilePath('a//b')).not.toBeNull()
    expect(validateFilePath('./a')).not.toBeNull()
    expect(validateFilePath('a\\b')).not.toBeNull()
    expect(validateFilePath('~/a')).not.toBeNull()
  })
})

describe('compareExecutableSequences', () => {
  const en = parseTutorialBlocks(`Prose.\n\n${fence('bash run', 'bun test')}\n\nMore.\n\n${fence('ts file=a.ts', 'x')}`, 'en.md')

  test('translated prose around identical blocks is a match', () => {
    const ja = parseTutorialBlocks(`散文。\n\n${fence('bash run', 'bun test')}\n\n続き。\n\n${fence('ts file=a.ts', 'x')}`, 'ja.md')
    expect(compareExecutableSequences(en, ja)).toEqual([])
  })

  test('a translated body, a changed attribute, or a missing block is reported once, at the first divergence', () => {
    const translatedBody = parseTutorialBlocks(`${fence('bash run', 'bun test')}\n${fence('ts file=a.ts', 'y')}`, 'ja.md')
    expect(compareExecutableSequences(en, translatedBody)).toMatchObject([{ file: 'ja.md', line: 4 }])

    const changedAttr = parseTutorialBlocks(`${fence('bash run fallback', 'bun test')}\n${fence('ts file=a.ts', 'x')}`, 'ja.md')
    expect(compareExecutableSequences(en, changedAttr)).toMatchObject([{ file: 'ja.md', line: 1 }])

    const missing = parseTutorialBlocks(fence('bash run', 'bun test'), 'ja.md')
    expect(compareExecutableSequences(en, missing)).toMatchObject([{ file: 'ja.md', line: 0 }])
    expect(compareExecutableSequences(en, missing)[0].message).toContain('missing executable block #2')

    const extra = parseTutorialBlocks(`${fence('bash run', 'bun test')}\n${fence('ts file=a.ts', 'x')}\n${fence('bash manual', 'x')}`, 'ja.md')
    expect(compareExecutableSequences(en, extra)[0].message).toContain('extra executable block #3')
  })

  test('illustrative fences never take part', () => {
    const withExample = parseTutorialBlocks(`${fence('bash', 'ls -la')}\n${fence('bash run', 'bun test')}\n${fence('ts file=a.ts', 'x')}`, 'ja.md')
    expect(executableBlocks(withExample.blocks)).toHaveLength(2)
    expect(compareExecutableSequences(en, withExample)).toEqual([])
  })
})

describe('command recognisers', () => {
  test('cdTarget reads exactly one cd and nothing cleverer', () => {
    expect(cdTarget('cd guren-blog')).toBe('guren-blog')
    expect(cdTarget('  cd guren-blog  \n')).toBe('guren-blog')
    expect(cdTarget('cd guren-blog && bun run dev')).toBeNull()
    expect(cdTarget('cd')).toBeNull()
    expect(cdTarget('cd "a b"')).toBeNull()
  })

  test('parseScaffoldCommand passes every flag through and refuses anything else', () => {
    expect(parseScaffoldCommand('bunx create-guren-app guren-blog --mode ssr --db sqlite --agents claude --git')).toEqual({
      target: 'guren-blog',
      flags: ['--mode', 'ssr', '--db', 'sqlite', '--agents', 'claude', '--git'],
    })
    expect(parseScaffoldCommand('bunx create-guren-app --mode ssr')).toBeNull()
    expect(parseScaffoldCommand('bunx create-guren-app guren-blog\ncd guren-blog')).toBeNull()
    expect(parseScaffoldCommand('bun create guren-app x')).toBeNull()
  })
})
