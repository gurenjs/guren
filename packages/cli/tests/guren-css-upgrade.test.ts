import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createTempWorkspace, type TempWorkspace } from './helpers'
import { getDoctorRuleEvaluations } from '../src/doctor'
import { planTokenSheet, readTokenSheet, SHIPPED_TOKEN_BLOCKS, SHIPPED_UNMARKED_SHEETS } from '../src/guren-css'
import { loadScaffoldTemplate } from '../src/scaffold-templates'
import { upgradeCanary } from '../src/upgrade'

const shipped = loadScaffoldTemplate('guren-ui/resources/css/guren.css')
const OPEN = '/* guren:tokens begin: replaced by guren upgrade */'
const CLOSE = '/* guren:tokens end */'

/** The sheets released before the markers, copied from the commits named in their file names. */
const UNMARKED_RELEASES = ['unmarked-6fc315695.css', 'unmarked-a06b28d85.css']

function unmarkedRelease(name: string): Promise<string> {
  return readFile(join(import.meta.dir, 'fixtures/guren-ui-sheets', name), 'utf8')
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

  it('ignores a marker-shaped line inside a longer comment', () => {
    // Without the comment rule, line 2 reads as a close with no open.
    const sheet = readTokenSheet(`/* notes:\n${CLOSE}\n${OPEN}\n${CLOSE}\n`)
    expect(sheet.problems).toEqual([])
    expect(sheet.block).toEqual({ open: 2, close: 3 })
  })

  it('ignores a marker sharing its line with a rule', () => {
    expect(readTokenSheet(`${OPEN}\n${CLOSE} .brand {}\n`).problems).toEqual(['line 1: the block "guren:tokens" opens and never closes'])
  })
})

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex')

function blockOf(sheet: string): string {
  const read = readTokenSheet(sheet)
  return read.lines.slice(read.block!.open, read.block!.close + 1).join('\n')
}

describe('planTokenSheet', () => {
  /** A later release's sheet, so the block shipped today is the earlier release's. */
  const newer = shipped.replace('--g-accent: #db1b1b;', '--g-accent: #c81818;')

  it('lists the shipped block among the released ones', () => {
    // Append the new block's hash to SHIPPED_TOKEN_BLOCKS whenever the sheet changes.
    expect(SHIPPED_TOKEN_BLOCKS.has(sha256(blockOf(shipped)))).toBe(true)
  })

  it('leaves the shipped sheet as it is', () => {
    expect(planTokenSheet(shipped, shipped)).toEqual({ kind: 'current' })
  })

  it('replaces a released block alone and keeps the text around it', () => {
    const plan = planTokenSheet(`/* mine */\n${shipped}.brand { color: red; }\n`, newer)
    expect(plan).toEqual({ kind: 'update', next: `/* mine */\n${newer}.brand { color: red; }\n` })
  })

  it('keeps CRLF line ends', () => {
    const crlf = (text: string): string => text.replace(/\n/g, '\r\n')
    expect(planTokenSheet(crlf(`${shipped}.x {}\n`), newer)).toEqual({ kind: 'update', next: crlf(`${newer}.x {}\n`) })
  })

  it('leaves a block no release shipped: edited, or newer than this CLI', () => {
    expect(planTokenSheet(newer, shipped)).toEqual({ kind: 'edited' })
    expect(planTokenSheet(`${OPEN}\n:root {}\n${CLOSE}\n`, shipped)).toEqual({ kind: 'edited' })
  })

  it('adopts every sheet released before the markers', async () => {
    const digests: string[] = []
    for (const name of UNMARKED_RELEASES) {
      const sheet = await unmarkedRelease(name)
      expect(planTokenSheet(sheet, shipped)).toEqual({ kind: 'adopt', next: shipped })
      expect(planTokenSheet(sheet.replace(/\n/g, '\r\n'), shipped)).toEqual({ kind: 'adopt', next: shipped.replace(/\n/g, '\r\n') })
      digests.push(sha256(sheet))
    }
    expect(new Set(digests)).toEqual(new Set(SHIPPED_UNMARKED_SHEETS))
  })

  it('does not touch an edited sheet without markers', async () => {
    expect(planTokenSheet(`${await unmarkedRelease(UNMARKED_RELEASES[1])}.brand {}\n`, shipped)).toEqual({ kind: 'unmarked' })
  })

  it('does not touch a sheet whose markers are broken', () => {
    expect(planTokenSheet(`${OPEN}\n:root {}\n`, shipped).kind).toBe('unsafe')
  })
})

describe('the guren-ui-tokens doctor rule', () => {
  let workspace: TempWorkspace
  const sheetPath = (): string => join(workspace.dir, 'resources/css/guren.css')
  const tokensCheck = async () =>
    (await getDoctorRuleEvaluations({ cwd: workspace.dir })).evaluations.find((evaluation) => evaluation.check.key === 'guren-ui-tokens')!

  beforeEach(async () => {
    workspace = await createTempWorkspace('guren-css-upgrade-')
    await writeFile(join(workspace.dir, 'package.json'), JSON.stringify({ name: 'tokens-test' }), 'utf8')
    await mkdir(join(workspace.dir, 'resources/css'), { recursive: true })
  })

  afterEach(async () => {
    await workspace.cleanup()
  })

  it('passes an app with no token sheet', async () => {
    expect((await tokensCheck()).check.status).toBe('pass')
  })

  it('reports an edited unmarked sheet with the steps to adopt the markers, and offers no autofix', async () => {
    await writeFile(sheetPath(), ':root { --g-accent: #000; }\n', 'utf8')
    const { check, autofix } = await tokensCheck()
    expect(check.status).toBe('warn')
    expect(autofix).toBeNull()
    expect(check.manualFix).toContain('/* guren:tokens end */')
  })

  it('reports a sheet it cannot read instead of failing the run', async () => {
    await mkdir(sheetPath())
    const { check } = await tokensCheck()
    expect(check.status).toBe('warn')
    expect(check.message).toContain('could not be read')
  })

  it('is applied by guren upgrade, and previewed under --dry-run', async () => {
    const released = await unmarkedRelease(UNMARKED_RELEASES[1])
    await writeFile(sheetPath(), released, 'utf8')

    const preview = await upgradeCanary({ cwd: workspace.dir, tag: 'canary', dryRun: true })
    expect(preview.autofixes.find((autofix) => autofix.key === 'guren-ui-tokens')?.applied).toBe(false)
    expect(await readFile(sheetPath(), 'utf8')).toBe(released)

    const result = await upgradeCanary({ cwd: workspace.dir, tag: 'canary' })
    expect(result.autofixes.find((autofix) => autofix.key === 'guren-ui-tokens')?.applied).toBe(true)
    expect(await readFile(sheetPath(), 'utf8')).toBe(shipped)
    expect((await tokensCheck()).check.status).toBe('pass')
  })
})
