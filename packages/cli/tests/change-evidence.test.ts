import { afterAll, beforeAll, describe, expect, setDefaultTimeout, spyOn, test } from 'bun:test'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { runCommand } from 'citty'

import { changeRecord, collectChangeEvidence, renderEvidenceMarkdown, writeChangeEvidence, type ChangeEvidenceOptions } from '../src/change/evidence'
import { runWithCommandStatus } from '../src/command-status'
import { builtinSubCommands } from '../src/commands'
import type { GateReport } from '../src/gate'
import { createTempRoot } from './helpers'

// Each case makes a repository and runs git a dozen times, past Bun's 5 s default under a loaded suite.
setDefaultTimeout(60_000)

const ROOT_PREFIX = 'guren-change-evidence-'
let ROOT: string
let repos = 0

beforeAll(async () => {
  ROOT = await createTempRoot(ROOT_PREFIX)
})

afterAll(async () => {
  await rm(ROOT, { recursive: true, force: true })
})

async function git(cwd: string, args: string[]): Promise<string> {
  const proc = Bun.spawn(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
  if (code !== 0) throw new Error(`git ${args.join(' ')} failed with code ${code}: ${stderr}`)
  return stdout.trim()
}

async function commit(repo: string, files: Record<string, string>): Promise<string> {
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(repo, path)), { recursive: true })
    await writeFile(join(repo, path), content, 'utf8')
  }
  await git(repo, ['add', '-A'])
  await git(repo, ['commit', '--allow-empty', '-m', 'change'])
  return git(repo, ['rev-parse', 'HEAD'])
}

async function createRepo(): Promise<{ repo: string; base: string }> {
  const repo = join(ROOT, `repo-${repos++}`)
  await mkdir(repo, { recursive: true })
  await git(repo, ['init', '--initial-branch=main'])
  await git(repo, ['config', 'user.email', 'test@example.com'])
  await git(repo, ['config', 'user.name', 'Test'])
  return { repo, base: await commit(repo, { 'README.md': '# app\n', 'docs/guide.md': 'A guide.\n' }) }
}

const gateReport = (ok: boolean): GateReport => ({ cwd: '', ok, changed: false, stages: [{ name: 'test', status: ok ? 'pass' : 'fail', durationMs: 1, findings: ok ? [] : ['1 test failed'] }] })
const holdCodes = (evidence: { holds: Array<{ code: string }> }): string[] => evidence.holds.map((hold) => hold.code)

async function evidenceOf(repo: string, base: string, head: string, overrides: Partial<ChangeEvidenceOptions> = {}) {
  return collectChangeEvidence({ cwd: repo, base, head, deps: false, audit: true, gate: async () => gateReport(true), ...overrides })
}

describe('collectChangeEvidence', () => {
  test('should call a low change with a passing gate and nothing held eligible', async () => {
    const { repo, base } = await createRepo()
    const evidence = await evidenceOf(repo, base, await commit(repo, { 'docs/guide.md': 'A longer guide.\n' }))

    expect(evidence).toMatchObject({ schemaVersion: 1, eligible: true, holds: [], migrationImpact: 'none', lane: { floor: 'low' } })
  })

  test('should hold a change whose gate failed, and keep the gate\'s report', async () => {
    const { repo, base } = await createRepo()
    const evidence = await evidenceOf(repo, base, await commit(repo, { 'docs/guide.md': 'A longer guide.\n' }), { gate: async () => gateReport(false) })

    expect(evidence.gate.ok).toBe(false)
    expect(holdCodes(evidence)).toEqual(['gate-failed'])
    expect(evidence.eligible).toBe(false)
  })

  test('should read a gate that could not run as a failed one', async () => {
    const { repo, base } = await createRepo()
    const evidence = await evidenceOf(repo, base, await commit(repo, { 'docs/guide.md': 'A longer guide.\n' }), { gate: async () => { throw new Error('codegen could not start') } })

    expect(evidence.gate).toMatchObject({ ok: false, stages: [] })
    expect(evidence.holds).toEqual([expect.objectContaining({ code: 'gate-failed', message: expect.stringContaining('codegen could not start') })])
  })

  test('should hold, not refuse, a checkout that is not at the head, and still run the gate', async () => {
    const { repo, base } = await createRepo()
    const head = await commit(repo, { 'docs/guide.md': 'A longer guide.\n' })
    await git(repo, ['checkout', '-q', base])
    let ran = 0

    const evidence = await evidenceOf(repo, base, head, { gate: async () => { ran++; return gateReport(true) } })

    expect(ran).toBe(1)
    expect(evidence.holds).toEqual([expect.objectContaining({ code: 'checkout-not-head', message: expect.stringContaining('not the merge commit') })])
  })

  test('should hold a checkout with uncommitted changes to tracked files', async () => {
    const { repo, base } = await createRepo()
    const head = await commit(repo, { 'docs/guide.md': 'A longer guide.\n' })
    await writeFile(join(repo, 'README.md'), '# edited\n', 'utf8')

    expect(holdCodes(await evidenceOf(repo, base, head))).toEqual(['checkout-dirty'])
  })

  test('should hold, not throw, when the change cannot be read', async () => {
    const { repo, base } = await createRepo()
    const head = await commit(repo, { 'docs/guide.md': 'A longer guide.\n' })
    const shallow = join(ROOT, `shallow-${repos++}`)
    await git(ROOT, ['clone', '-q', '--depth', '1', `file://${repo}`, shallow])

    const evidence = await evidenceOf(shallow, base, head)

    expect(evidence.lane).toBeUndefined()
    expect(holdCodes(evidence)).toEqual(['lane-unavailable', 'plan-evidence-unavailable', 'browser-evidence-unavailable'])
    expect(evidence.holds[0]!.message).toContain('fetch-depth: 0')
    expect(evidence.eligible).toBe(false)
  })

  test('should hold a change that edits a page or a routes file for its browser evidence', async () => {
    const { repo, base } = await createRepo()
    const head = await commit(repo, { 'resources/js/pages/posts/Index.tsx': 'export default function Index() { return null }\n', 'db/migrations/0001_posts/migration.sql': 'CREATE TABLE "posts" ("id" serial PRIMARY KEY);\n' })

    const evidence = await evidenceOf(repo, base, head, { audit: false })

    expect(holdCodes(evidence)).toEqual(['browser-evidence-unavailable'])
    expect(evidence.migrationImpact).toBe('additive')
  })

  test('should hold a change under a plan that is not closed', async () => {
    const { repo, base } = await createRepo()
    const evidence = await evidenceOf(repo, base, await commit(repo, { 'docs/plans/broken/plan.json': '{' }), { audit: false })

    expect(evidence.holds).toContainEqual(expect.objectContaining({ code: 'plan-evidence-unavailable', message: expect.stringContaining('docs/plans/broken/plan.json (unreadable)') }))
  })
})

describe('the record and the summary', () => {
  test('should write the three files, the default directory ignoring itself, and keep finding text out of the record', async () => {
    const { repo, base } = await createRepo()
    const head = await commit(repo, { 'docs/guide.md': 'A longer guide.\n' })
    const evidence = await evidenceOf(repo, base, head, { gate: async () => gateReport(false) })

    const dir = await writeChangeEvidence(repo, '.guren/evidence', evidence, await changeRecord(repo, base, head, evidence))
    const record = JSON.parse(await readFile(join(dir, 'record.json'), 'utf8'))

    expect(await readFile(join(dir, '.gitignore'), 'utf8')).toBe('*\n')
    expect(JSON.parse(await readFile(join(dir, 'evidence.json'), 'utf8'))).toEqual(JSON.parse(JSON.stringify(evidence)))
    expect(await readFile(join(dir, 'evidence.md'), 'utf8')).toBe(renderEvidenceMarkdown(evidence))
    expect(record).toMatchObject({ recordVersion: 1, base, head, mergeBase: base, floor: 'low', eligible: false, gate: { ok: false, stages: [{ name: 'test', status: 'fail' }] } })
    expect(record.securityRecords).toEqual({ unavailable: expect.any(String) })
    expect(typeof record.cli).toBe('string')
    expect(JSON.stringify(record)).not.toContain('1 test failed')
  })

  test('should open the summary with the conclusion', async () => {
    const { repo, base } = await createRepo()
    const evidence = await evidenceOf(repo, base, await commit(repo, { 'docs/guide.md': 'A longer guide.\n' }))

    expect(renderEvidenceMarkdown(evidence).split('\n')[0]).toBe('## Change evidence: floor `low`, eligible for low')
  })
})

describe('change:evidence', () => {
  test('should fail exactly when the gate fails, after writing its files', async () => {
    const { repo, base } = await createRepo()
    const head = await commit(repo, { 'docs/guide.md': 'A longer guide.\n', 'package.json': JSON.stringify({ name: 'app', scripts: { test: 'false' } }) })
    const log = spyOn(console, 'log').mockImplementation(() => {})
    try {
      const exitCode = await runWithCommandStatus(() => runCommand(builtinSubCommands['change:evidence'], { rawArgs: ['--base', base, '--head', head, '--app', repo, '--no-deps', '--no-audit', '--json'] }))
      const evidence = JSON.parse(String(log.mock.calls.at(-1)?.[0]))

      expect(evidence.gate.ok).toBe(false)
      expect(exitCode).toBe(1)
      expect(await readFile(join(repo, '.guren/evidence/record.json'), 'utf8')).toContain(`"head": "${head}"`)
    } finally {
      log.mockRestore()
    }
  })

  test('should refuse to run without both commits', async () => {
    await expect(runCommand(builtinSubCommands['change:evidence'], { rawArgs: ['--head', 'abc1234'] })).rejects.toThrow('needs both --base <sha> and --head <sha>')
  })
})
