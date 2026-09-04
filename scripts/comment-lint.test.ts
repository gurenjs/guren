import { describe, expect, test } from 'bun:test'
import { collectBlocks, lintSource, newFindings, SKIP_PATH } from './comment-lint'

const rules = (src: string, file = 'x.ts') => lintSource(src, file).map((f) => f.rule)

describe('comment-lint rules', () => {
  test('flags a block whose body exceeds five lines', () => {
    const src = `const a = 1\n/**\n * one\n * two\n * three\n * four\n * five\n * six\n */\nexport const b = 2\n`
    expect(rules(src)).toEqual(['long-block'])
  })

  test('allows a module header up to eight lines but not nine', () => {
    const eight = `/**\n${' * l\n'.repeat(8)} */\nexport const a = 1\n`
    const nine = `/**\n${' * l\n'.repeat(9)} */\nexport const a = 1\n`
    expect(rules(eight)).toEqual([])
    expect(rules(nine)).toEqual(['long-block'])
  })

  test('a run of adjacent line comments is one block', () => {
    const src = `const z = 0\n${'// l\n'.repeat(6)}const a = 1\n`
    expect(rules(src)).toEqual(['long-block'])
    expect(collectBlocks(src, 'x.ts')).toHaveLength(1)
  })

  test('trailing comments never count as blocks', () => {
    const src = `const a = 1 // one\nconst b = 2 // two\nconst c = 3 // three\nconst d = 4 // four\nconst e = 5 // five\nconst f = 6 // six\n`
    expect(rules(src)).toEqual([])
  })

  test('flags banners, step labels, history wording, and self-restating @param', () => {
    expect(rules(`// ---------- helpers ----------\nconst a = 1\n`)).toEqual(['banner'])
    expect(rules(`// Step 2: validate\nconst a = 1\n`)).toEqual(['step-label'])
    expect(rules(`// This used to be a loop\nconst a = 1\n`)).toEqual(['history'])
    expect(rules(`/**\n * Sum.\n * @param total - the total\n */\nexport function f(total: number) { return total }\n`)).toEqual(['param-restates'])
    expect(rules(`/**\n * Sum.\n * @param total - bytes, not characters\n */\nexport function f(total: number) { return total }\n`)).toEqual([])
  })

  test('never inspects comments inside template literals or strings', () => {
    const src = 'const tpl = `\n// ---- banner ----\n// Step 1\n// used to\n`\nconst s = "// previously"\n'
    expect(rules(src)).toEqual([])
  })

  test('protected comments are exempt from every rule', () => {
    const src = `// eslint-disable-next-line no-console ---------\nconsole.log(1)\n/**\n * @deprecated used to be the default\n${' * l\n'.repeat(7)} */\nexport const a = 1\n// comment-lint-ignore: pinned by tests/x.test.ts\n${'// l\n'.repeat(6)}export const b = 2\n`
    expect(rules(src)).toEqual([])
  })

  test('jsx files parse with the jsx plugin and .ts keeps arrow generics', () => {
    expect(rules(`const f = <T,>(x: T) => x\nexport default () => <div>{/* ---- */}{f(1)}</div>\n`, 'x.tsx')).toEqual(['banner'])
    expect(rules(`const f = <T>(x: T) => x\n// used to\nexport default f\n`, 'x.ts')).toEqual(['history'])
  })
})

describe('ratchet', () => {
  test('only findings absent from the base version are new', () => {
    const base = lintSource(`// Step 1\nconst a = 1\n`, 'x.ts')
    const head = lintSource(`// Step 1\nconst a = 1\n// Step 2\nconst b = 2\n`, 'x.ts')
    expect(newFindings(base, head).map((f) => f.line)).toEqual([3])
    expect(newFindings(head, base)).toEqual([])
  })
})

describe('skip list', () => {
  test('generated, vendored, template, and fixture paths are excluded', () => {
    for (const p of ['packages/cli/templates/scaffold/a.ts', 'packages/create-app/templates/b.ts', 'a/.guren/pages.gen.ts', 'x/dist/index.js', 'packages/cli/tests/fixtures/f.ts', 'web/stubs/s.ts', 'packages/server/src/a.d.ts']) {
      expect(SKIP_PATH.test(p)).toBe(true)
    }
    expect(SKIP_PATH.test('packages/server/src/http/Application.ts')).toBe(false)
  })
})

describe('ratchet against git revisions', () => {
  const { mkdtemp, mkdir, rm, writeFile } = require('node:fs/promises') as typeof import('node:fs/promises')
  const { tmpdir } = require('node:os') as typeof import('node:os')
  const { join, dirname } = require('node:path') as typeof import('node:path')
  const { changedFiles, lintFileRatcheted } = require('./comment-lint') as typeof import('./comment-lint')
  const HERMETIC = ['-c', 'commit.gpgsign=false', '-c', 'user.name=t', '-c', 'user.email=t@guren.dev']
  const git = (repo: string, ...args: string[]) => {
    const p = Bun.spawnSync(['git', ...HERMETIC, ...args], { cwd: repo })
    if (!p.success) throw new Error(`git ${args.join(' ')}: ${p.stderr.toString()}`)
    return p.stdout.toString().trim()
  }
  const commit = async (repo: string, files: Record<string, string>) => {
    for (const [p, c] of Object.entries(files)) {
      await mkdir(dirname(join(repo, p)), { recursive: true })
      await writeFile(join(repo, p), c)
    }
    git(repo, 'add', '-A')
    git(repo, 'commit', '--quiet', '-m', 'c')
    return git(repo, 'rev-parse', 'HEAD')
  }
  const LONG = `${'// l\n'.repeat(6)}`

  test('a committed head is judged against the merge base, not against what main merged later', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'guren-comment-lint-'))
    try {
      git(repo, 'init', '--quiet', '--initial-branch=main')
      const base = await commit(repo, { 'src/a.ts': `export const a = 1\n${LONG}export const b = 2\n`, 'src/pr.ts': 'export const p = 1\n' })
      git(repo, 'checkout', '--quiet', '-b', 'pr')
      const head = await commit(repo, { 'src/pr.ts': `export const p = 1\n${LONG}export const q = 2\n` })
      git(repo, 'checkout', '--quiet', 'main')
      const tip = await commit(repo, { 'src/a.ts': 'export const a = 1\nexport const b = 2\n' })

      expect(changedFiles(base, head, repo)).toEqual(['src/pr.ts'])
      expect(lintFileRatcheted('src/pr.ts', base, head, repo).map((f) => f.rule)).toEqual(['long-block'])
      // Diffing against the moved tip would blame the PR for main's own cleanup of src/a.ts.
      expect(changedFiles(tip, head, repo)).toContain('src/a.ts')
      expect(lintFileRatcheted('src/a.ts', tip, head, repo)).toHaveLength(1)
      expect(lintFileRatcheted('src/a.ts', base, head, repo)).toHaveLength(0)
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })
})
