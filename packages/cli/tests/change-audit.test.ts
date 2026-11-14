import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import type { AuditFinding, AuditReport } from '../src/audit'
import { auditFacts } from '../src/change/audit-facts'
import { judgeChangeLane, type ChangeLaneReport } from '../src/change/lane'
import { openChange, resolveChange, type ChangedPath, type ChangeReader, type ResolvedChange } from '../src/change/resolve'
import { auditChangeRevisions } from '../src/change/revision-audit'
import { createTempRoot, DEFAULT_ROUTES_FIXTURE, linkWorkspaceCore } from './helpers'

const ROOT_PREFIX = 'guren-change-audit-test-'
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
  await git(repo, ['commit', '-m', 'change'])
  return git(repo, ['rev-parse', 'HEAD'])
}

const RAW_SQL = 'const rows = await db.execute(sql.raw(`SELECT * FROM users WHERE id = ${userId}`))\n'
const CONTROLLER_PATH = 'app/Http/Controllers/PostController.ts'
const controller = (body = ''): string => `export class PostController {\n  async index() {\n${body}  }\n}\n`

const APP_FILES: Record<string, string> = {
  '.gitignore': 'node_modules\n.guren\n',
  'package.json': JSON.stringify({ name: 'app', type: 'module' }),
  'bun.lock': '{}',
  'routes/web.ts': DEFAULT_ROUTES_FIXTURE,
  'src/app.ts': 'export const options = {}\n',
  [CONTROLLER_PATH]: controller(),
}

async function createApp(files: Record<string, string> = APP_FILES, install = true): Promise<{ repo: string; base: string }> {
  const repo = join(ROOT, `repo-${repos++}`)
  await mkdir(repo, { recursive: true })
  await git(repo, ['init', '--initial-branch=main'])
  await git(repo, ['config', 'user.email', 'test@example.com'])
  await git(repo, ['config', 'user.name', 'Test'])
  const base = await commit(repo, files)
  if (install) await linkWorkspaceCore(repo)
  return { repo, base }
}

async function laneOf(repo: string, base: string, head: string): Promise<ChangeLaneReport> {
  const change = await resolveChange(repo, base, head)
  const { reader, dispose } = openChange(repo, change)
  try {
    return await judgeChangeLane(change, reader, { audit: () => auditChangeRevisions(repo, change, reader) })
  } finally {
    await dispose()
  }
}

const readers = (report: ChangeLaneReport): string[] => report.unjudged.map((entry) => entry.reader)

describe('change:lane with the audit of both sides', () => {
  test('should call an audit failure the base did not have high', async () => {
    const { repo, base } = await createApp()
    const report = await laneOf(repo, base, await commit(repo, { [CONTROLLER_PATH]: controller(`    ${RAW_SQL}`) }))

    expect(report.facts).toContainEqual(expect.objectContaining({ code: 'audit-fail', lane: 'high', target: `raw-sql:${CONTROLLER_PATH}:3`, files: [CONTROLLER_PATH] }))
    expect(readers(report)).not.toContain('audit')
    expect(report.floor).toBe('high')
  })

  test('should not call a failure new when an edit above it only moved its line', async () => {
    const { repo, base } = await createApp({ ...APP_FILES, [CONTROLLER_PATH]: controller(`    ${RAW_SQL}`) })
    const report = await laneOf(repo, base, await commit(repo, { [CONTROLLER_PATH]: `// a note\n${controller(`    ${RAW_SQL}`)}` }))

    expect(report.facts.map((fact) => fact.code)).toEqual(['source-edited'])
    expect(readers(report)).not.toContain('audit')
    expect(report.floor).toBe('medium')
  })

  test('should call a security default switched off high', async () => {
    const { repo, base } = await createApp()
    const report = await laneOf(repo, base, await commit(repo, { 'src/app.ts': 'export const options = { autoCsrf: false }\n' }))

    expect(report.facts).toContainEqual(expect.objectContaining({ code: 'audit-warn-changed', lane: 'high', files: ['src/app.ts'] }))
  })

  test('should not audit a base whose lockfile is not the one installed', async () => {
    const { repo, base } = await createApp()
    const report = await laneOf(repo, base, await commit(repo, { 'bun.lock': '{ "changed": true }', [CONTROLLER_PATH]: controller(`    ${RAW_SQL}`) }))

    expect(report.unjudged).toContainEqual(expect.objectContaining({ reader: 'audit', lane: 'medium', reason: expect.stringContaining('the base was not audited: bun.lock at') }))
    expect(report.facts.map((fact) => fact.code)).not.toContain('audit-fail')
  })

  test('should say the audit was not taken where nothing is installed', async () => {
    const { repo, base } = await createApp(APP_FILES, false)
    const report = await laneOf(repo, base, await commit(repo, { [CONTROLLER_PATH]: controller(`    ${RAW_SQL}`) }))

    expect(report.unjudged).toContainEqual(expect.objectContaining({ reader: 'audit', reason: expect.stringContaining('no node_modules is installed here') }))
  })

  test('should not run the audit for a change that touches nothing it reads', async () => {
    const { repo, base } = await createApp()
    const head = await commit(repo, { 'docs/guide.md': 'A guide.\n' })
    const change = await resolveChange(repo, base, head)
    const { reader, dispose } = openChange(repo, change)
    let asked = 0

    const report = await judgeChangeLane(change, reader, { audit: () => { asked++; return auditChangeRevisions(repo, change, reader) } })
    await dispose()

    expect(asked).toBe(0)
    expect(report.floor).toBe('low')
  })
})

function report(findings: Array<Partial<AuditFinding> & Pick<AuditFinding, 'key'>>): AuditReport {
  return { findings: findings.map((finding) => ({ title: finding.key, status: 'warn', message: 'a finding', ...finding })), routesAnalyzed: true } as AuditReport
}

function fakeChange(paths: ChangedPath[]): ResolvedChange {
  return { base: 'b', head: 'h', mergeBase: 'b', appPrefix: '', paths }
}

function fakeReader(files: Record<'base' | 'head', Record<string, string>>): ChangeReader {
  return { read: async (side, path) => files[side][path] ?? null } as ChangeReader
}

describe('auditFacts', () => {
  const edited = fakeChange([{ path: 'app/Http/Controllers/PostController.ts', status: 'modified' }])
  const noFiles = fakeReader({ base: {}, head: {} })
  const codes = async (base: AuditReport, head: AuditReport, change = edited, reader = noFiles): Promise<string[]> =>
    (await auditFacts(change, reader, base, head)).map((fact) => `${fact.code} ${fact.target}`)

  test('should call a warning that became a failure an audit failure', async () => {
    expect(await codes(report([{ key: 'auth:POST /posts' }]), report([{ key: 'auth:POST /posts', status: 'fail' }]))).toEqual(['audit-fail auth:POST /posts'])
    expect(await codes(report([{ key: 'auth:POST /posts', status: 'fail' }]), report([{ key: 'auth:POST /posts', status: 'fail' }]))).toEqual([])
  })

  test('should call an escalating warning high only on a file the change touches', async () => {
    const warning = (filePath: string) => report([{ key: 'policy:POST /posts', filePath }])

    expect(await codes(report([]), warning('app/Http/Controllers/PostController.ts'))).toEqual(['audit-warn-changed policy:POST /posts'])
    expect(await codes(report([]), warning('app/Http/Controllers/CommentController.ts'))).toEqual([])
  })

  test('should call a sensitive column, a CSRF exemption and a suppression the base did not have by their own facts', async () => {
    const head = report([
      { key: 'exposure-sensitive-column:User.passwordHash:app/Http/Resources/UserResource.ts:toArray' },
      { key: 'csrf-exemption:plugin', message: 'a-plugin calls declareCookielessAuthPath' },
      { key: 'auth:POST /posts', status: 'ignored' },
      { key: 'csrf-exemption:plugin-ok', status: 'pass' },
    ])
    const base = report([{ key: 'csrf-exemption:plugin', message: 'no plugin calls it', status: 'pass' }, { key: 'auth:POST /posts', status: 'fail' }])

    expect(await codes(base, head)).toEqual([
      'audit-suppressed auth:POST /posts',
      'sensitive-exposure exposure-sensitive-column:User.passwordHash:app/Http/Resources/UserResource.ts:toArray',
      'csrf-exemption csrf-exemption:plugin',
    ])
    expect(await codes(head, head)).toEqual([])
  })

  test('should know a line-anchored finding by its line text across a rename', async () => {
    const renamed = fakeChange([{ path: 'app/Support/Query.ts', status: 'renamed', oldPath: 'app/Support/Sql.ts' }])
    const reader = fakeReader({ base: { 'app/Support/Sql.ts': 'a\nraw()\n' }, head: { 'app/Support/Query.ts': 'a\nb\nraw()\nraw()\n' } })
    const base = report([{ key: 'raw-sql:app/Support/Sql.ts:2', status: 'fail', filePath: 'app/Support/Sql.ts', line: 2 }])
    const head = report([3, 4].map((line) => ({ key: `raw-sql:app/Support/Query.ts:${line}`, status: 'fail' as const, filePath: 'app/Support/Query.ts', line })))

    expect(await codes(base, head, renamed, reader)).toEqual(['audit-fail raw-sql:app/Support/Query.ts:4'])
  })
})
