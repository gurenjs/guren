import { afterAll, beforeAll, describe, expect, setDefaultTimeout, spyOn, test } from 'bun:test'
import { mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { runCommand } from 'citty'

import { changeRecord, collectChangeEvidence, redactSecrets, renderEvidenceMarkdown, writeChangeEvidence, type ChangeEvidenceOptions } from '../src/change/evidence'
import { runWithCommandStatus } from '../src/command-status'
import { builtinSubCommands } from '../src/commands'
import type { GateReport } from '../src/gate'
import { SECURITY_RECORD_VERSION } from '../src/change/security-records'
import { createTempRoot, DEFAULT_ROUTES_FIXTURE, linkWorkspaceCore } from './helpers'

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

  test('should hold a change to a translation catalog, which a page renders as its labels', async () => {
    const { repo, base } = await createRepo()
    const evidence = await evidenceOf(repo, base, await commit(repo, { 'lang/en/posts.json': '{ "title": "Title" }\n' }), { audit: false })

    expect(evidence.lane?.floor).toBe('low')
    expect(holdCodes(evidence)).toEqual(['browser-evidence-unavailable'])
  })

  test('should hold a change whose head is behind its base, rather than call it empty and low', async () => {
    const { repo, base } = await createRepo()
    const ahead = await commit(repo, { 'package.json': JSON.stringify({ scripts: { test: 'true' } }) })

    const swapped = await evidenceOf(repo, ahead, base)

    expect(holdCodes(swapped)).toContain('change-empty')
    expect(swapped.holds.find((hold) => hold.code === 'change-empty')?.message).toContain('were --base and --head swapped')
    expect(swapped.eligible).toBe(false)
  })

  test('should hold what the gate rewrote among the committed files', async () => {
    const { repo, base } = await createRepo()
    const head = await commit(repo, { '.guren/routes.gen.ts': 'export {}\n' })
    const gate = async () => {
      await writeFile(join(repo, '.guren/routes.gen.ts'), 'export const regenerated = true\n', 'utf8')
      return gateReport(true)
    }

    const evidence = await evidenceOf(repo, base, head, { gate })

    expect(evidence.holds).toEqual([expect.objectContaining({ code: 'gate-rewrote-tree', message: expect.stringContaining('.guren/routes.gen.ts') })])
  })

  test('should see an uncommitted file above an application below the repository root', async () => {
    const { repo, base } = await createRepo()
    const head = await commit(repo, { 'tsconfig.base.json': '{}\n', 'apps/web/docs/guide.md': 'A guide.\n' })
    await writeFile(join(repo, 'tsconfig.base.json'), '{ "compilerOptions": {} }\n', 'utf8')

    const evidence = await evidenceOf(join(repo, 'apps/web'), base, head)

    expect(evidence.holds).toContainEqual(expect.objectContaining({ code: 'checkout-dirty', message: expect.stringContaining('tsconfig.base.json') }))
  })

  test('should hold a checkout that moved while the gate ran', async () => {
    const { repo, base } = await createRepo()
    const head = await commit(repo, { 'docs/guide.md': 'A longer guide.\n' })
    const gate = async () => {
      await git(repo, ['checkout', '-q', base])
      return gateReport(true)
    }

    expect(holdCodes(await evidenceOf(repo, base, head, { gate }))).toEqual(['checkout-moved'])
  })

  test('should hold a change to the routes entry --routes names, and a page moved out of the pages directory', async () => {
    const { repo, base } = await createRepo()
    const custom = await evidenceOf(repo, base, await commit(repo, { 'docs/web.ts': 'export {}\n' }), { audit: false, routesFile: 'docs/web.ts' })
    const withPage = await commit(repo, { 'resources/js/pages/About.tsx': 'export default function About() { return null }\n' })
    await mkdir(join(repo, 'notes'), { recursive: true })
    await git(repo, ['mv', 'resources/js/pages/About.tsx', 'notes/About.tsx'])
    const moved = await evidenceOf(repo, withPage, await commit(repo, {}), { audit: false })

    expect(custom.lane?.floor).toBe('low')
    expect(holdCodes(custom)).toEqual(['browser-evidence-unavailable'])
    expect(moved.holds).toContainEqual(expect.objectContaining({ code: 'browser-evidence-unavailable', message: expect.stringContaining('resources/js/pages/About.tsx') }))
  })

  test('should hold, not throw, on a rejection that has no string form', async () => {
    const { repo, base } = await createRepo()
    const evidence = await evidenceOf(repo, base, await commit(repo, { 'docs/guide.md': 'A longer guide.\n' }), { gate: async () => { throw Object.create(null) } })

    expect(evidence.holds).toEqual([expect.objectContaining({ code: 'gate-failed', message: 'the gate could not run: a value with no message' })])
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

    const dir = await writeChangeEvidence(repo, join(repo, '.guren/evidence'), evidence, await changeRecord(repo, base, head, evidence, false))
    const record = JSON.parse(await readFile(join(dir, 'record.json'), 'utf8'))

    expect(await readFile(join(dir, '.gitignore'), 'utf8')).toBe('*\n')
    expect(JSON.parse(await readFile(join(dir, 'evidence.json'), 'utf8'))).toEqual(JSON.parse(JSON.stringify(evidence)))
    expect(await readFile(join(dir, 'evidence.md'), 'utf8')).toBe(renderEvidenceMarkdown(evidence))
    expect(record).toMatchObject({ recordVersion: 1, base, head, mergeBase: base, floor: 'low', eligible: false, unjudged: [], audit: { compared: false, loadedCode: false }, holds: [{ code: 'gate-failed', lane: 'medium' }], gate: { ok: false, deps: false, stages: [{ name: 'test', status: 'fail' }] } })
    expect(record.securityRecords).toEqual({ unavailable: 'not-exported' })
    expect(typeof record.cli).toBe('string')
    expect(JSON.stringify(record)).not.toContain('1 test failed')
  })

  test('should carry the head\'s security records into the record, and why there are none', async () => {
    const { repo, base } = await createRepo()
    const head = await commit(repo, { 'docs/guide.md': 'A longer guide.\n' })
    const lane = (await evidenceOf(repo, base, head, { audit: false })).lane!
    const routes = { recordVersion: SECURITY_RECORD_VERSION, routes: [] }
    const read = await evidenceOf(repo, base, head, { lane: async (...args) => { args[5]?.(routes); return lane } })
    const unread = await evidenceOf(repo, base, head, { lane: async (...args) => { args[5]?.({ unavailable: 'the base was not audited: bun.lock differs', code: 'not-exported' }); return lane } })

    expect((await changeRecord(repo, base, head, read, false)).securityRecords).toEqual(routes)
    expect((await changeRecord(repo, base, head, unread, false)).securityRecords).toEqual({ unavailable: 'not-exported' })
    expect(unread.securityRecords).toEqual({ unavailable: 'the base was not audited: bun.lock differs', code: 'not-exported' })
  })

  test('should read the server version through the application\'s @guren/core when none sits beside it', async () => {
    const { repo, base } = await createRepo()
    const head = await commit(repo, { 'docs/guide.md': 'A longer guide.\n' })
    const store = join(ROOT, `store-${repos++}`)
    await mkdir(join(store, 'node_modules/@guren/server'), { recursive: true })
    await mkdir(join(store, 'node_modules/@guren/core'), { recursive: true })
    await writeFile(join(store, 'node_modules/@guren/server/package.json'), JSON.stringify({ name: '@guren/server', version: '9.8.7' }), 'utf8')
    await mkdir(join(repo, 'node_modules/@guren'), { recursive: true })
    await symlink(join(store, 'node_modules/@guren/core'), join(repo, 'node_modules/@guren/core'), 'dir')

    const record = await changeRecord(repo, base, head, await evidenceOf(repo, base, head), true)

    expect(record.server).toBe('9.8.7')
  })

  test('should mask credentials in every file and keep error text out of the record\'s holds', async () => {
    const { repo, base } = await createRepo()
    const head = await commit(repo, { 'docs/guide.md': 'A longer guide.\n' })
    const gate = async (): Promise<GateReport> => ({ cwd: repo, ok: false, changed: false, stages: [{ name: 'test', status: 'fail', durationMs: 1, findings: ['DATABASE_URL=postgres://app:hunter2@db/app refused'] }] })
    const lane = async () => {
      throw new Error('connection failed: postgres://app:hunter2@db/app')
    }
    const evidence = await evidenceOf(repo, base, head, { gate, lane })
    const record = await changeRecord(repo, base, head, evidence, false)

    const dir = await writeChangeEvidence(repo, '.guren/evidence', evidence, record)
    const written = await Promise.all(['evidence.json', 'record.json', 'evidence.md'].map((name) => readFile(join(dir, name), 'utf8')))

    expect(written.join('\n')).not.toContain('hunter2')
    expect(record.holds.every((hold) => Object.keys(hold).sort().join() === 'code,lane')).toBe(true)
    expect(redactSecrets('https://alice:s3cret@host/x GITHUB_TOKEN=ghp_1 plain=ok')).toBe('https://[redacted]@host/x GITHUB_TOKEN=[redacted] plain=ok')
  })

  test('should write the files it can when one of them cannot be written', async () => {
    const { repo, base } = await createRepo()
    const head = await commit(repo, { 'docs/guide.md': 'A longer guide.\n' })
    const evidence = await evidenceOf(repo, base, head)
    const out = join(repo, 'out')
    await mkdir(join(out, 'evidence.json'), { recursive: true })

    await expect(writeChangeEvidence(repo, out, evidence, await changeRecord(repo, base, head, evidence, false))).rejects.toThrow('evidence.json:')
    expect(await readFile(join(out, 'record.json'), 'utf8')).toContain('"recordVersion": 1')
    expect(await readFile(join(out, 'evidence.md'), 'utf8')).toBe(renderEvidenceMarkdown(evidence))
  })

  test('should read the server version through a @guren/core hoisted above the application', async () => {
    const { repo, base } = await createRepo()
    const head = await commit(repo, { 'apps/web/docs/guide.md': 'A guide.\n' })
    const store = join(ROOT, `store-${repos++}`)
    await mkdir(join(store, 'node_modules/@guren/core'), { recursive: true })
    await mkdir(join(store, 'node_modules/@guren/server'), { recursive: true })
    await writeFile(join(store, 'node_modules/@guren/server/package.json'), JSON.stringify({ name: '@guren/server', version: '1.2.3' }), 'utf8')
    await mkdir(join(repo, 'node_modules/@guren'), { recursive: true })
    await symlink(join(store, 'node_modules/@guren/core'), join(repo, 'node_modules/@guren/core'), 'dir')
    const app = join(repo, 'apps/web')

    expect((await changeRecord(app, base, head, await evidenceOf(app, base, head), false)).server).toBe('1.2.3')
  })

  test('should open the summary with the conclusion', async () => {
    const { repo, base } = await createRepo()
    const evidence = await evidenceOf(repo, base, await commit(repo, { 'docs/guide.md': 'A longer guide.\n' }))

    expect(renderEvidenceMarkdown(evidence).split('\n')[0]).toBe('## Change evidence: floor `low`, eligible for low')
  })

  test('should hand --base-record to the lane and name the stored base the records were compared with', async () => {
    const { repo, base } = await createRepo()
    const head = await commit(repo, { 'docs/guide.md': 'A longer guide.\n' })
    const lane = (await evidenceOf(repo, base, head, { audit: false })).lane!
    let given: string | undefined
    const stored = { ...lane, records: { compared: true, stored: { head: 'b'.repeat(40), cli: '2.37.3', server: null } } }
    const evidence = await evidenceOf(repo, base, head, { baseRecord: '/tmp/base/record.json', lane: async (...args) => { given = args[6]; return stored } })

    expect(given).toBe('/tmp/base/record.json')
    expect(renderEvidenceMarkdown(evidence)).toContain('Security records were compared with the base record stored for bbbbbbbbbbbb (@guren/cli 2.37.3, @guren/server unknown).')
  })

  test('should hold a change whose REVIEW.md block is stale or could not be checked, and leave an app without one alone', async () => {
    const { repo } = await createRepo()
    const base = await commit(repo, { 'REVIEW.md': '# Review\n' })
    const head = await commit(repo, { 'docs/guide.md': 'A longer guide.\n' })
    const asked: string[] = []
    const reviewDoc = (result: Awaited<ReturnType<NonNullable<ChangeEvidenceOptions['reviewDoc']>>>) => async (cwd: string) => {
      asked.push(cwd)
      return result
    }

    const stale = await evidenceOf(repo, base, head, { reviewDoc: reviewDoc({ state: 'read', files: [{ file: 'REVIEW.md', state: 'stale' }], gaps: [] }) })
    const unread = await evidenceOf(repo, base, head, { reviewDoc: reviewDoc({ state: 'unreadable', reasons: ['the routes: no-entry'] }) })
    const current = await evidenceOf(repo, base, head, { reviewDoc: reviewDoc({ state: 'read', files: [{ file: 'REVIEW.md', state: 'unchanged' }], gaps: [] }) })

    expect(holdCodes(stale)).toEqual(['review-doc-stale'])
    expect(stale.gate.ok).toBe(true)
    expect(holdCodes(unread)).toEqual(['review-doc-unchecked'])
    expect(holdCodes(current)).toEqual([])

    const { repo: bare, base: bareBase } = await createRepo()
    await evidenceOf(bare, bareBase, await commit(bare, { 'docs/guide.md': 'A longer guide.\n' }), { reviewDoc: reviewDoc({ state: 'unreadable', reasons: [] }) })
    expect(asked).toHaveLength(3)
  })

  test('should name the lane guren.review.ts set and the approvals it asks of the floor', async () => {
    const { repo } = await createRepo()
    const base = await commit(repo, { 'guren.review.ts': "export default { facts: { ambient: 'medium' }, approvals: { medium: 1 } }\n" })
    const evidence = await evidenceOf(repo, base, await commit(repo, { 'docs/guide.md': 'A longer guide.\n' }))
    const markdown = renderEvidenceMarkdown(evidence)

    expect(evidence.lane?.floor).toBe('medium')
    expect(markdown).toContain('(raised by guren.review.ts from low)')
    expect(markdown).toContain('guren.review.ts at the merge base applies: a medium change needs 1 approval where someone other than the author can approve. Nothing enforces it yet.')
    expect((await changeRecord(repo, base, evidence.lane!.head, evidence, false)).facts).toEqual([{ code: 'ambient', lane: 'medium', policyFrom: 'low', target: 'documentation', files: ['docs/guide.md'] }])
  })
})

/** A repository whose gate passes or fails on its `test` script alone: codegen, check and audit pass on its one route, lint skips. */
async function gatedRepo(testScript: 'true' | 'false'): Promise<{ repo: string; base: string; head: string }> {
  const { repo, base } = await createRepo()
  const head = await commit(repo, {
    '.gitignore': 'node_modules\n.guren\ntypes\n',
    'routes/web.ts': DEFAULT_ROUTES_FIXTURE,
    'docs/plans/draft.plan.json': '{',
    'package.json': JSON.stringify({ name: 'app', type: 'module', scripts: { typecheck: 'true', test: testScript } }),
  })
  await linkWorkspaceCore(repo)
  return { repo, base, head }
}

async function runEvidence(rawArgs: string[]): Promise<{ exitCode: number; evidence: { gate: GateReport; holds: unknown[] }; errors: string[] }> {
  const log = spyOn(console, 'log').mockImplementation(() => {})
  const error = spyOn(console, 'error').mockImplementation(() => {})
  try {
    const exitCode = await runWithCommandStatus(() => runCommand(builtinSubCommands['change:evidence'], { rawArgs: [...rawArgs, '--no-deps', '--no-audit', '--json'] }))
    return { exitCode, evidence: JSON.parse(String(log.mock.calls.at(-1)?.[0])), errors: error.mock.calls.map((call) => String(call[0])) }
  } finally {
    log.mockRestore()
    error.mockRestore()
  }
}

describe('change:evidence', () => {
  test('should pass on a passing gate whatever holds the change, and fail on a failing one', async () => {
    const passing = await gatedRepo('true')
    const failing = await gatedRepo('false')

    const passed = await runEvidence(['--base', passing.base, '--head', passing.head, '--app', passing.repo])
    const failed = await runEvidence(['--base', failing.base, '--head', failing.head, '--app', failing.repo])

    expect(passed.evidence.gate.ok).toBe(true)
    expect(passed.evidence.holds.length).toBeGreaterThan(0)
    expect(passed.exitCode).toBe(0)
    expect(failed.evidence.gate.ok).toBe(false)
    expect(failed.exitCode).toBe(1)
    expect(await readFile(join(failing.repo, '.guren/evidence/record.json'), 'utf8')).toContain(`"head": "${failing.head}"`)
  })

  test('should keep the gate\'s exit code when the evidence cannot be written', async () => {
    const { repo, base, head } = await gatedRepo('true')
    const blocked = join(repo, 'blocked')
    await writeFile(blocked, 'a file, not a directory\n', 'utf8')

    const run = await runEvidence(['--base', base, '--head', head, '--app', repo, '-o', blocked])

    expect(run.exitCode).toBe(0)
    expect(run.errors).toEqual([expect.stringContaining(`The evidence could not be written to ${blocked}`)])
  })

  test('should refuse to run without both commits', async () => {
    await expect(runCommand(builtinSubCommands['change:evidence'], { rawArgs: ['--head', 'abc1234'] })).rejects.toThrow('needs both --base <sha> and --head <sha>')
  })
})
