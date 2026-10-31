import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createTempWorkspace, type TempWorkspace } from './helpers'
import { judgeTokenSheet, planTokenSheet, readTokenSheet, SHIPPED_UNMARKED_SHEETS, updateTokenSheet } from '../src/guren-css'
import { loadScaffoldTemplate } from '../src/scaffold-templates'
import { upgradeCanary } from '../src/upgrade'

const repoRoot = join(import.meta.dir, '../../..')
const shipped = loadScaffoldTemplate('guren-ui/resources/css/guren.css')
const OPEN = '/* guren:tokens begin: replaced by guren upgrade */'
const CLOSE = '/* guren:tokens end */'

/** The sheets released before the markers, from the commits that last changed them. */
const UNMARKED_RELEASES = [
  '6fc315695:packages/cli/templates/scaffold/guren-ui/resources/css/guren.css',
  'a06b28d85:packages/cli/templates/scaffold/guren-ui/resources/css/guren.css',
]

function gitShow(spec: string): string {
  const git = Bun.spawnSync(['git', 'show', spec], { cwd: repoRoot })
  if (git.exitCode !== 0) throw new Error(`git show ${spec} exited ${git.exitCode}: ${git.stderr.toString().trim()}`)
  return git.stdout.toString()
}

describe('readTokenSheet', () => {
  it('finds one block in the shipped sheet', () => {
    const sheet = readTokenSheet(shipped)
    expect(sheet.problems).toEqual([])
    expect(sheet.block).toBeDefined()
    expect(sheet.lines[sheet.block!.close]).toBe(CLOSE)
  })

  it('refuses an open marker that never closes', () => {
    expect(readTokenSheet(`${OPEN}\n:root {}\n`).problems).toEqual(['line 1: the block "guren:tokens" opens and never closes'])
  })

  it('refuses a close marker that never opened', () => {
    expect(readTokenSheet(`:root {}\n${CLOSE}\n`).problems).toEqual(['line 2: the block "guren:tokens" closes and never opened'])
  })

  it('refuses a second block', () => {
    const block = `${OPEN}\n:root {}\n${CLOSE}\n`
    expect(readTokenSheet(`${block}${block}`).problems).toEqual(['line 4: the block "guren:tokens" appears twice'])
  })

  it('ignores a marker inside a block comment', () => {
    const sheet = readTokenSheet(`/*\n${CLOSE.slice(0, -2)}\n*/\n${OPEN}\n${CLOSE}\n`)
    expect(sheet.problems).toEqual([])
    expect(sheet.block).toEqual({ open: 3, close: 4 })
  })
})

describe('planTokenSheet', () => {
  const sheetWith = (block: string, before = '', after = ''): string => `${before}${OPEN}\n${block}\n${CLOSE}\n${after}`

  it('leaves the shipped sheet as it is', () => {
    expect(planTokenSheet(shipped, shipped)).toEqual({ kind: 'current' })
  })

  it('replaces the block alone and keeps the text around it', () => {
    const current = sheetWith(':root { --g-accent: #000; }', '/* mine */\n', '.brand { color: red; }\n')
    const plan = planTokenSheet(current, shipped)
    expect(plan.kind).toBe('update')
    const next = (plan as { next: string }).next
    expect(next.startsWith('/* mine */\n/* guren:tokens begin')).toBe(true)
    expect(next.endsWith(`${CLOSE}\n.brand { color: red; }\n`)).toBe(true)
    expect(next).toContain('--g-accent: #db1b1b;')
    expect(planTokenSheet(next, shipped)).toEqual({ kind: 'current' })
  })

  it('keeps CRLF line ends', () => {
    const plan = planTokenSheet(sheetWith(':root {}', '', '.x {}\n').replace(/\n/g, '\r\n'), shipped)
    const next = (plan as { next: string }).next
    expect(next).not.toMatch(/[^\r]\n/)
    expect(planTokenSheet(next, shipped)).toEqual({ kind: 'current' })
  })

  it('adopts every sheet released before the markers', () => {
    const digests = UNMARKED_RELEASES.map((spec) => {
      const sheet = gitShow(spec)
      expect(planTokenSheet(sheet, shipped)).toEqual({ kind: 'adopt', next: shipped })
      expect(planTokenSheet(sheet.replace(/\n/g, '\r\n'), shipped)).toEqual({ kind: 'adopt', next: shipped.replace(/\n/g, '\r\n') })
      return createHash('sha256').update(sheet).digest('hex')
    })
    expect(new Set(digests)).toEqual(new Set(SHIPPED_UNMARKED_SHEETS))
  })

  it('does not touch an edited sheet without markers', () => {
    expect(planTokenSheet(`${gitShow(UNMARKED_RELEASES[1])}.brand {}\n`, shipped)).toEqual({ kind: 'unmarked' })
  })

  it('does not touch a sheet whose markers are broken', () => {
    expect(planTokenSheet(`${OPEN}\n:root {}\n`, shipped).kind).toBe('unsafe')
  })
})

describe('the guren-ui-tokens doctor rule', () => {
  let workspace: TempWorkspace
  const sheetPath = (): string => join(workspace.dir, 'resources/css/guren.css')

  beforeEach(async () => {
    workspace = await createTempWorkspace('guren-css-upgrade-')
    await writeFile(join(workspace.dir, 'package.json'), JSON.stringify({ name: 'tokens-test' }), 'utf8')
    await mkdir(join(workspace.dir, 'resources/css'), { recursive: true })
  })

  afterEach(async () => {
    await workspace.cleanup()
  })

  it('passes an app with no token sheet and writes none', async () => {
    await workspace.cleanup()
    workspace = await createTempWorkspace('guren-css-upgrade-')
    expect((await judgeTokenSheet(workspace.dir)).status).toBe('pass')
    expect(await updateTokenSheet(workspace.dir)).toBe(false)
  })

  it('reports an edited unmarked sheet with the steps to adopt the markers, and leaves it', async () => {
    await writeFile(sheetPath(), ':root { --g-accent: #000; }\n', 'utf8')
    const verdict = await judgeTokenSheet(workspace.dir)
    expect(verdict.status).toBe('warn')
    expect(verdict.canAutofix).toBeUndefined()
    expect(verdict.manualFix).toContain('/* guren:tokens end */')
    expect(await updateTokenSheet(workspace.dir)).toBe(false)
    expect(await readFile(sheetPath(), 'utf8')).toBe(':root { --g-accent: #000; }\n')
  })

  it('is applied by guren upgrade, and previewed under --dry-run', async () => {
    const stale = `${OPEN}\n:root { --g-accent: #000; }\n${CLOSE}\n.brand {}\n`
    await writeFile(sheetPath(), stale, 'utf8')

    const preview = await upgradeCanary({ cwd: workspace.dir, tag: 'canary', dryRun: true })
    expect(preview.autofixes.find((autofix) => autofix.key === 'guren-ui-tokens')?.applied).toBe(false)
    expect(await readFile(sheetPath(), 'utf8')).toBe(stale)

    const result = await upgradeCanary({ cwd: workspace.dir, tag: 'canary' })
    expect(result.autofixes.find((autofix) => autofix.key === 'guren-ui-tokens')?.applied).toBe(true)
    const updated = await readFile(sheetPath(), 'utf8')
    expect(updated.endsWith(`${CLOSE}\n.brand {}\n`)).toBe(true)
    expect((await judgeTokenSheet(workspace.dir)).status).toBe('pass')
  })
})
