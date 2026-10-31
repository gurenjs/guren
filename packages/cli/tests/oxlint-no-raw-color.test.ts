import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { lintFixture, OXLINT_BIN } from './helpers'
import { collectFiles, toPosixRelative } from '../src/discovery'

// Exercised through the real oxlint binary, like the sibling rules: what has to
// hold is that the plugin loads and reports on the AST oxlint hands it.

const repoRoot = resolve(import.meta.dir, '../../..')
const plugin = resolve(import.meta.dir, '../src/oxlint/no-raw-color.js')

function lint(source: string): string {
  return lintFixture({
    config: { jsPlugins: [plugin], rules: { 'guren-no-raw-color/no-raw-color': 'error' } },
    file: 'case.tsx',
    source,
  })
}

/** Lines of `source` the rule reports, in the order oxlint prints them. */
function reportedLines(source: string): number[] {
  return [...lint(source).matchAll(/^case\.tsx:(\d+):\d+: .*no-raw-color/gm)].map((m) => Number(m[1]))
}

/** The raw colors the rule names, one per report. */
function reported(source: string): string[] {
  return [...lint(source).matchAll(/^case\.tsx:\d+:\d+: `([^`]+)`/gm)].map((m) => m[1]!)
}

describe('guren/no-raw-color', () => {
  test('reports Tailwind palette utilities under variants, important and opacity', () => {
    expect(reported(`const a = <p className="text-zinc-500 md:hover:!bg-red-500/50 [&:hover]:border-gray-100 bg-black/40" />
const b = <p className="ring-blue-600 ring-offset-white from-rose-50 to-rose-950 border-x-slate-200 fill-white" />
`)).toEqual([
      'text-zinc-500', 'md:hover:!bg-red-500/50', '[&:hover]:border-gray-100', 'bg-black/40',
      'ring-blue-600', 'ring-offset-white', 'from-rose-50', 'to-rose-950', 'border-x-slate-200', 'fill-white',
    ])
  })

  test('reports an arbitrary value that holds a color', () => {
    expect(reported(`const a = <p className="bg-[#db1b1b] shadow-[0_1px_#000] text-[color:rgb(0_0_0)] bg-[oklch(60%_0.2_30)]" />
`)).toEqual(['bg-[#db1b1b]', 'shadow-[0_1px_#000]', 'text-[color:rgb(0_0_0)]', 'bg-[oklch(60%_0.2_30)]'])
  })

  // A class string is a class string wherever it is held: an agent that moves
  // `bg-red-500` into a lookup table has not moved it onto a token.
  test('reads class strings outside className: helpers, constants, template literals', () => {
    expect(reportedLines(`const a = <p className={clsx('border-white', ok && 'ring-blue-600')} />
const tones = { danger: 'bg-red-50 text-red-700' }
const b = <p className={\`p-4 \${size} bg-[#db1b1b]\`} />
`)).toEqual([1, 1, 2, 2, 3])
  })

  test('leaves tokens, non-color utilities and module specifiers alone', () => {
    expect(reportedLines(`import red from 'bg-red-500'
const a = <p className="bg-g-accent text-g-on-accent border-g-line bg-[var(--g-accent)] bg-transparent text-current" />
const b = <p className="text-lg bg-red border-2 to-50% from-g-accent grid-cols-[1fr_2fr] bg-red-500-ish" />
const c = <p className={\`bg-\${tone}-500\`} />
const d = 'see #123 for details'
`)).toEqual([])
  })

  test('reports a hex or color function in a style prop, through conditionals', () => {
    expect(reported(`const a = <div style={{ color: '#fff', background: ok ? 'rgb(0 0 0)' : 'var(--g-page)', width: 10 }} />
const b = <div style={{ borderColor: \`hsl(0 0% 50%)\`, boxShadow: 'var(--g-shadow-card)' }} />
`)).toEqual(['#fff', 'rgb(0 0 0)', 'hsl(0 0% 50%)'])
  })

  test('reports an SVG paint attribute, but not currentColor or none', () => {
    expect(reported(`const a = <svg><path fill="#db1b1b" stroke="currentColor" /><stop stopColor={'#000'} /><rect fill="none" /></svg>
`)).toEqual(['#db1b1b', '#000'])
  })

  test('names the token vocabulary, so the message is actionable', () => {
    expect(lint(`const a = <p className="bg-white" />\n`))
      .toContain('`bg-white` is a raw color. Use a Guren UI token from resources/css/guren.css')
  })

  // The shipped config enables the rule on resources/js/**, so every page and
  // component Guren writes into an app has to pass it, or a fresh app starts red.
  test('passes every page and component Guren ships into an app', async () => {
    const files: string[] = []
    for (const root of ['packages/create-app/templates', 'packages/cli/templates/scaffold']) {
      for (const file of await collectFiles(join(repoRoot, root), new Set(['.ts', '.tsx']), new Set(['node_modules']))) {
        const path = toPosixRelative(repoRoot, file)
        if (path.includes('/resources/js/')) files.push(path)
      }
    }
    expect(files.length).toBeGreaterThan(0)
    const dir = mkdtempSync(join(tmpdir(), 'guren-oxlint-raw-color-'))
    try {
      writeFileSync(join(dir, 'oxlintrc.json'), JSON.stringify({ jsPlugins: [plugin], rules: { 'guren-no-raw-color/no-raw-color': 'error' } }))
      const result = Bun.spawnSync(
        [OXLINT_BIN, '--disable-nested-config', '-c', join(dir, 'oxlintrc.json'), '-A', 'all', '-D', 'guren-no-raw-color/no-raw-color', '--format', 'unix', ...files],
        { cwd: repoRoot, stdout: 'pipe', stderr: 'pipe' },
      )
      expect(result.stderr.toString()).toBe('')
      expect(result.stdout.toString()).toBe('')
      expect(result.exitCode).toBe(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 30_000)
})
