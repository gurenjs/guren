import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

// Exercised through the real oxlint binary, like await-async-assertion: what has
// to hold is that the plugin loads and reports on the comments oxlint hands it.

const repoRoot = resolve(import.meta.dir, '../../..')
const oxlint = join(repoRoot, 'node_modules', '.bin', 'oxlint')
const plugin = join(repoRoot, 'packages', 'cli', 'src', 'oxlint', 'comments.js')
const RULES = ['comment-length', 'comment-banner', 'comment-step-label', 'comment-history', 'comment-param-restates']

/** `rule@line` for every finding oxlint reports on `source`, in print order. */
function findings(source: string, file = 'case.ts'): string[] {
  const dir = mkdtempSync(join(tmpdir(), 'guren-comment-rules-'))
  try {
    const rules = Object.fromEntries(RULES.map((r) => [`guren-comments/${r}`, 'error']))
    writeFileSync(join(dir, '.oxlintrc.json'), JSON.stringify({ jsPlugins: [plugin], rules }))
    writeFileSync(join(dir, file), source)
    const result = Bun.spawnSync([oxlint, '-c', '.oxlintrc.json', '-A', 'all', ...RULES.flatMap((r) => ['-D', `guren-comments/${r}`]), '--format', 'unix', file], {
      cwd: dir,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const stdout = result.stdout.toString()
    const stderr = result.stderr.toString()
    if (stderr.trim() !== '') throw new Error(`oxlint wrote to stderr:\n${stderr}`)
    if (new RegExp(`^${file.replace('.', '\\.')}:0:0:`, 'm').test(stdout)) throw new Error(`the plugin threw while linting the fixture:\n${stdout}`)
    return [...stdout.matchAll(/^case\.\w+:(\d+):\d+: .*guren-comments\((comment-[a-z-]+)\)/gm)].map((m) => `${m[2]}@${m[1]}`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const LONG = '// l\n'.repeat(6)

describe('guren/comment-*', () => {
  test('a block whose body exceeds five lines; a module header may run to eight', () => {
    expect(findings(`const a = 1\n/**\n * one\n * two\n * three\n * four\n * five\n * six\n */\nexport const b = 2\n`)).toEqual(['comment-length@2'])
    expect(findings(`/**\n${' * l\n'.repeat(8)} */\nexport const a = 1\n`)).toEqual([])
    expect(findings(`/**\n${' * l\n'.repeat(9)} */\nexport const a = 1\n`)).toEqual(['comment-length@1'])
  })

  test('adjacent line comments form one block; trailing comments never do', () => {
    expect(findings(`const z = 0\n${LONG}const a = 1\n`)).toEqual(['comment-length@2'])
    expect(findings(`const a = 1 // one\nconst b = 2 // two\nconst c = 3 // three\nconst d = 4 // four\nconst e = 5 // five\nconst f = 6 // six\n`)).toEqual([])
  })

  test('banners, step labels, history wording, and self-restating @param', () => {
    expect(findings(`// ---------- helpers ----------\nconst a = 1\n`)).toEqual(['comment-banner@1'])
    expect(findings(`// Step 2: validate\nconst a = 1\n`)).toEqual(['comment-step-label@1'])
    expect(findings(`const z = 0\n/**\n * Step 1: load\n */\nconst a = 1\n`)).toEqual(['comment-step-label@3'])
    expect(findings(`// This used to be a loop\nconst a = 1\n`)).toEqual(['comment-history@1'])
    expect(findings(`// The token is used to sign in\nconst a = 1\n`)).toEqual([])
    expect(findings(`/**\n * Sum.\n * @param total - the total\n */\nexport function f(total: number) { return total }\n`)).toEqual(['comment-param-restates@1'])
    expect(findings(`/**\n * Sum.\n * @param total - bytes, not characters\n */\nexport function f(total: number) { return total }\n`)).toEqual([])
  })

  test('template literals and strings are not comments', () => {
    expect(findings('const tpl = `\n// ---- banner ----\n// Step 1\n// used to\n`\nconst s = "// previously"\n')).toEqual([])
  })

  test('directives, framework tags, and @deprecated exempt a block from every rule', () => {
    const src = `// eslint-disable-next-line no-console ---------\nconsole.log(1)\n/**\n * @deprecated used to be the default\n${' * l\n'.repeat(7)} */\nexport const a = 1\n`
    expect(findings(src)).toEqual([])
  })

  test('an oxlint-disable-next-line above the block suppresses one rule with a reason', () => {
    const src = `const z = 0\n// oxlint-disable-next-line guren-comments/comment-length -- pinned by a test\n${LONG}export const a = 1\n`
    expect(findings(src)).toEqual([])
  })

  test('tsx parses; a JSX banner is a banner', () => {
    expect(findings(`const f = <T,>(x: T) => x\nexport default () => <div>{/* ---- */}{f(1)}</div>\n`, 'case.tsx')).toEqual(['comment-banner@2'])
  })
})
