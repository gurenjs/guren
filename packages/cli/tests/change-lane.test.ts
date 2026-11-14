import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { runCommand } from 'citty'

import { judgeChangeLane, type ChangeLaneReport } from '../src/change/lane'
import { openChange, resolveChange } from '../src/change/resolve'
import { builtinSubCommands } from '../src/commands'
import { renderChangeLane } from '../src/commands/change'
import { createTempRoot, PG_SCHEMA_FIXTURE } from './helpers'
import { approvePlanFile, loadApprovedCommentsPlan, loadCommentsPlan } from './plan-fixture'

const ROOT_PREFIX = 'guren-change-lane-'
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

/** Writes the files (`null` deletes one), commits, and returns the commit's SHA. */
async function commit(repo: string, files: Record<string, string | null>): Promise<string> {
  for (const [path, content] of Object.entries(files)) {
    if (content === null) {
      await rm(join(repo, path))
      continue
    }
    await mkdir(dirname(join(repo, path)), { recursive: true })
    await writeFile(join(repo, path), content, 'utf8')
  }
  await git(repo, ['add', '-A'])
  await git(repo, ['commit', '--allow-empty', '-m', 'change'])
  return git(repo, ['rev-parse', 'HEAD'])
}

const POLICY = (abilities: string[]): string => `import { Policy } from '@guren/core'

export class PostPolicy extends Policy {
${abilities.map((name) => `  ${name}() {\n    return true\n  }`).join('\n')}
}
`

const BASE_FILES: Record<string, string> = {
  'package.json': JSON.stringify({ name: 'app', scripts: { test: 'bun test', lint: 'oxlint -c lint/rules.json' }, dependencies: { zod: '^4.0.0' } }, null, 2),
  'lint/rules.json': '{}',
  'README.md': '# app\n',
  'docs/guide.md': 'A guide.\n',
  'db/schema.ts': PG_SCHEMA_FIXTURE,
  'db/migrations/0001_users/migration.sql': 'CREATE TABLE "users" ("id" serial PRIMARY KEY);\n',
  'app/Policies/PostPolicy.ts': POLICY(['view', 'update']),
  'app/Http/Controllers/PostController.ts': 'export class PostController {}\n',
  'tests/posts.test.ts': "test('[AC-posts-1] lists posts', () => {})\n",
  'tests/helpers.test.ts': "test('adds', () => {})\n",
  'tests/browser/generated/smoke.browser.ts': '// generated\n',
}

async function createRepo(files: Record<string, string> = BASE_FILES): Promise<{ repo: string; base: string }> {
  const repo = join(ROOT, `repo-${repos++}`)
  await mkdir(repo, { recursive: true })
  await git(repo, ['init', '--initial-branch=main'])
  await git(repo, ['config', 'user.email', 'test@example.com'])
  await git(repo, ['config', 'user.name', 'Test'])
  return { repo, base: await commit(repo, files) }
}

async function laneOf(cwd: string, base: string, head: string): Promise<ChangeLaneReport> {
  const change = await resolveChange(cwd, base, head)
  const { reader, dispose } = openChange(cwd, change)
  try {
    return await judgeChangeLane(change, reader)
  } finally {
    await dispose()
  }
}

/** The report of one commit on top of the base fixture. */
async function laneAfter(files: Record<string, string | null>): Promise<ChangeLaneReport> {
  const { repo, base } = await createRepo()
  return laneOf(repo, base, await commit(repo, files))
}

const codes = (report: ChangeLaneReport): string[] => report.facts.map((fact) => fact.code).sort()
const factAt = (report: ChangeLaneReport, code: string) => report.facts.find((fact) => fact.code === code)

describe('resolveChange', () => {
  test('should refuse a base that is not a SHA', async () => {
    const { repo, base } = await createRepo()
    await expect(resolveChange(repo, 'main', base)).rejects.toThrow('takes a commit SHA')
  })

  test('should refuse a commit the clone does not have', async () => {
    const { repo, base } = await createRepo()
    await expect(resolveChange(repo, base, 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef')).rejects.toThrow('is not in this clone')
  })

  test('should refuse two commits that share no history', async () => {
    const { repo, base } = await createRepo()
    await git(repo, ['checkout', '--orphan', 'other'])
    const orphan = await commit(repo, { 'README.md': '# other\n' })
    await expect(resolveChange(repo, base, orphan)).rejects.toThrow('share no history')
  })

  test('should return each path with its status and a rename with its old path', async () => {
    const { repo, base } = await createRepo()
    await git(repo, ['mv', 'docs/guide.md', 'docs/handbook.md'])
    const head = await commit(repo, { 'README.md': '# renamed app\n', 'lint/rules.json': null, 'app/Models/Post.ts': 'export class Post {}\n' })

    const change = await resolveChange(repo, base.slice(0, 12), head)

    expect(change.base).toBe(base)
    expect(change.mergeBase).toBe(base)
    expect(change.paths.sort((a, b) => (a.path < b.path ? -1 : 1))).toEqual([
      { path: 'README.md', status: 'modified' },
      { path: 'app/Models/Post.ts', status: 'added' },
      { path: 'docs/handbook.md', status: 'renamed', oldPath: 'docs/guide.md' },
      { path: 'lint/rules.json', status: 'deleted' },
    ])
  })

  test('should read from the merge base, leaving out what only the base branch changed', async () => {
    const { repo, base } = await createRepo()
    await git(repo, ['checkout', '-b', 'feature'])
    const head = await commit(repo, { 'app/Models/Post.ts': 'export class Post {}\n' })
    await git(repo, ['checkout', 'main'])
    const moved = await commit(repo, { 'README.md': '# moved on\n' })

    const change = await resolveChange(repo, moved, head)

    expect(change.mergeBase).toBe(base)
    expect(change.paths).toEqual([{ path: 'app/Models/Post.ts', status: 'added' }])
  })

  test('should mark a path outside the application root and keep the rest app-relative', async () => {
    const { repo, base } = await createRepo({ 'apps/web/package.json': '{}', '.github/workflows/ci.yml': 'on: push\n', 'notes.txt': 'a\n' })
    const head = await commit(repo, { 'apps/web/app/Models/Post.ts': 'export class Post {}\n', '.github/workflows/ci.yml': 'on: pull_request\n', 'notes.txt': 'b\n' })

    const report = await laneOf(join(repo, 'apps/web'), base, head)

    expect(report.facts.map((fact) => [fact.code, fact.lane, fact.files])).toEqual([
      ['gate-input', 'high', ['.github/workflows/ci.yml']],
      ['outside-app', 'medium', ['notes.txt']],
      ['file-added', 'medium', ['app/Models/Post.ts']],
    ])
  })
})

describe('judgeChangeLane', () => {
  test('should put a documentation-only change in the low lane', async () => {
    const report = await laneAfter({ 'docs/guide.md': 'A longer guide.\n', 'docs/more.md': 'More.\n' })

    expect(report.floor).toBe('low')
    expect(report.facts).toEqual([{ code: 'ambient', lane: 'low', target: 'documentation', evidence: 'path', message: '2 files: documentation', files: ['docs/guide.md', 'docs/more.md'] }])
    expect(report.unjudged).toEqual([])
  })

  test('should report an empty change as low with no fact', async () => {
    const { repo, base } = await createRepo()
    const report = await laneOf(repo, base, base)

    expect(report).toMatchObject({ schemaVersion: 1, base, mergeBase: base, head: base, floor: 'low', facts: [], unjudged: [], plans: [] })
  })

  test('should call a rewritten package.json script a gate input', async () => {
    const report = await laneAfter({ 'package.json': JSON.stringify({ name: 'app', scripts: { test: 'true', lint: 'oxlint -c lint/rules.json' }, dependencies: { zod: '^4.0.0' } }, null, 2) })

    expect(report.floor).toBe('high')
    expect(factAt(report, 'gate-input')).toMatchObject({ lane: 'high', target: 'package.json scripts', message: 'scripts changed: test' })
    expect(codes(report)).toEqual(['gate-input'])
  })

  test('should call a file a script names a gate input', async () => {
    const report = await laneAfter({ 'lint/rules.json': '{"rules":{}}' })

    expect(factAt(report, 'gate-input')?.message).toContain('a package.json script names it')
  })

  test('should report changed dependencies and that their advisories were not read', async () => {
    const report = await laneAfter({ 'package.json': JSON.stringify({ name: 'app', scripts: { test: 'bun test', lint: 'oxlint -c lint/rules.json' }, dependencies: { zod: '^4.1.0' } }, null, 2), 'bun.lock': '{}' })

    expect(codes(report)).toEqual(['dependencies-changed', 'dependencies-changed'])
    expect(report.unjudged.map((entry) => entry.reader)).toContain('dependency-advisory')
    expect(report.floor).toBe('medium')
  })

  test('should not read an unparsable package.json as unchanged scripts', async () => {
    const report = await laneAfter({ 'package.json': '{ not json' })

    expect(report.unjudged).toContainEqual(expect.objectContaining({ reader: 'manifest', lane: 'high' }))
    expect(report.floor).toBe('high')
  })

  test('should call a plan, its approvals and its revision records plan records', async () => {
    const report = await laneAfter({ 'docs/plans/comments/approvals.json': '{}', 'comments.revisions/1.json': '{}', 'comments.decisions.json': '{}' })

    expect(report.facts.map((fact) => [fact.code, fact.lane])).toEqual([['plan-record', 'high'], ['plan-record', 'high'], ['plan-record', 'high']])
  })

  test('should call a deleted test file a removed test', async () => {
    const report = await laneAfter({ 'tests/helpers.test.ts': null })

    expect(report.facts).toEqual([expect.objectContaining({ code: 'test-removed', lane: 'high', files: ['tests/helpers.test.ts'] })])
  })

  test('should call a deleted or edited test that carries an acceptance id an acceptance change', async () => {
    const deleted = await laneAfter({ 'tests/posts.test.ts': null })
    const edited = await laneAfter({ 'tests/posts.test.ts': "test('lists posts', () => {})\n" })

    expect(factAt(deleted, 'acceptance-changed')?.message).toContain('it carried AC-posts-1')
    expect(factAt(edited, 'acceptance-changed')).toMatchObject({ lane: 'high', message: 'tests/posts.test.ts: an acceptance test edited; no longer carries AC-posts-1' })
  })

  test('should call a test renamed out of the test glob an acceptance change', async () => {
    const { repo, base } = await createRepo()
    await git(repo, ['mv', 'tests/posts.test.ts', 'tests/posts.ts.bak'])
    const report = await laneOf(repo, base, await commit(repo, {}))

    expect(factAt(report, 'acceptance-changed')?.message).toContain('which no test run collects')
  })

  test('should let an added test through as low unless it repeats an existing id', async () => {
    const fresh = await laneAfter({ 'tests/comments.test.ts': "test('[AC-comments-1] adds a comment', () => {})\n" })
    const repeated = await laneAfter({ 'tests/posts-again.test.ts': "test('[AC-posts-1] lists posts', () => {})\n" })

    expect(fresh.facts).toEqual([expect.objectContaining({ code: 'test-added', lane: 'low' })])
    expect(repeated.facts).toEqual([expect.objectContaining({ code: 'file-added', lane: 'medium' })])
  })

  test('should treat a generated browser spec as ambient, deleted or not', async () => {
    const report = await laneAfter({ 'tests/browser/generated/smoke.browser.ts': null })

    expect(report.facts).toEqual([expect.objectContaining({ code: 'ambient', lane: 'low', target: 'generated files' })])
  })

  test('should call a dropped ability or a deleted policy a removed policy', async () => {
    const dropped = await laneAfter({ 'app/Policies/PostPolicy.ts': POLICY(['view']) })
    const deleted = await laneAfter({ 'app/Policies/PostPolicy.ts': null })

    expect(factAt(dropped, 'policy-removed')).toMatchObject({ lane: 'high', message: 'app/Policies/PostPolicy.ts: abilities removed: update' })
    expect(factAt(deleted, 'policy-removed')).toMatchObject({ lane: 'high' })
  })

  test('should keep a policy edit that removes no ability at medium', async () => {
    const report = await laneAfter({ 'app/Policies/PostPolicy.ts': POLICY(['view', 'update', 'delete']), 'app/Policies/CommentPolicy.ts': POLICY(['view']) })

    expect(report.facts.map((fact) => [fact.code, fact.lane])).toEqual([['policy-added', 'medium'], ['policy-changed', 'medium']])
    expect(report.unjudged.map((entry) => entry.reader)).toEqual(['security-records', 'audit'])
  })

  test('should not read a policy that does not parse as one that kept its abilities', async () => {
    const report = await laneAfter({ 'app/Policies/PostPolicy.ts': 'export class PostPolicy {' })

    expect(report.unjudged).toContainEqual(expect.objectContaining({ reader: 'policy', lane: 'high' }))
  })

  test('should report what a schema edit declares, table by table', async () => {
    const report = await laneAfter({
      'db/schema.ts': `${PG_SCHEMA_FIXTURE.replace("pgTable('users', {", "pgTable('users', {\n  nickname: text('nickname'),")}
export const posts = pgTable('posts', { id: serial('id').primaryKey() })
`,
    })

    expect(report.facts.map((fact) => [fact.code, fact.target, fact.message])).toEqual([
      ['schema-changed', 'users', 'table users: columns added: nickname'],
      ['schema-changed', 'posts', 'table posts added (1 columns)'],
    ])
  })

  test('should not read a schema that does not parse as one with no tables', async () => {
    const report = await laneAfter({ 'db/schema.ts': 'export const users = pgTable(' })

    expect(report.unjudged).toContainEqual(expect.objectContaining({ reader: 'schema', lane: 'medium', files: ['db/schema.ts'] }))
    expect(codes(report)).toEqual(['source-edited'])
  })

  test('should read a schema edit that declares nothing new as an edit to source', async () => {
    const report = await laneAfter({ 'db/schema.ts': `// a note\n${PG_SCHEMA_FIXTURE}` })

    expect(report.facts).toEqual([expect.objectContaining({ code: 'source-edited', lane: 'medium', message: 'db/schema.ts: no table the reader sees changed' })])
  })

  test('should judge an added migration and call a destructive one high', async () => {
    const harmless = await laneAfter({ 'db/migrations/0002_posts/migration.sql': 'CREATE TABLE "posts" ("id" serial PRIMARY KEY);\n' })
    const destructive = await laneAfter({ 'db/migrations/0002_drop/migration.sql': 'DROP TABLE "users";\n' })

    expect(harmless.facts).toEqual([expect.objectContaining({ code: 'migration', lane: 'medium', target: 'db/migrations/0002_posts' })])
    expect(factAt(destructive, 'migration-destructive')).toMatchObject({ lane: 'high', target: 'db/migrations/0002_drop', evidence: 'static' })
  })

  test('should call an edit to an existing migration destructive', async () => {
    const report = await laneAfter({ 'db/migrations/0001_users/migration.sql': 'CREATE TABLE "users" ("id" bigserial PRIMARY KEY);\n' })

    expect(report.facts).toEqual([expect.objectContaining({ code: 'migration-destructive', lane: 'high', evidence: 'path' })])
  })

  test('should call a new audit suppression high', async () => {
    const report = await laneAfter({ 'app/Http/Controllers/PostController.ts': '// guren-audit-ignore\nexport class PostController {}\n' })

    expect(factAt(report, 'audit-suppressed')).toMatchObject({ lane: 'high' })
  })

  test('should say what it did not judge for an edit to a controller', async () => {
    const report = await laneAfter({ 'app/Http/Controllers/PostController.ts': 'export class PostController {\n  index() {}\n}\n' })

    expect(report.facts).toEqual([expect.objectContaining({ code: 'source-edited', lane: 'medium' })])
    expect(report.unjudged.map((entry) => [entry.reader, entry.lane])).toEqual([['security-records', 'medium'], ['audit', 'medium']])
    expect(report.floor).toBe('medium')
  })

  test('should give every changed path at least one fact', async () => {
    const { repo, base } = await createRepo()
    await git(repo, ['mv', 'README.md', 'ABOUT.md'])
    const head = await commit(repo, {
      'docs/lessons/authorize-first.md': 'A lesson.\n',
      'lang/en/app.json': '{ "hello": "Hello" }\n',
      '.guren/routes.gen.ts': 'export {}\n',
      'app/Models/Post.ts': 'export class Post {}\n',
      'lint/rules.json': null,
      'bin/serve.ts': 'export {}\n',
    })
    const change = await resolveChange(repo, base, head)
    const report = await laneOf(repo, base, head)

    const judged = new Set(report.facts.flatMap((fact) => fact.files))
    expect(change.paths.filter((entry) => !judged.has(entry.path))).toEqual([])
    expect(factAt(report, 'lesson')?.lane).toBe('medium')
    expect(factAt(report, 'source-renamed')?.files).toEqual(['ABOUT.md'])
  })

  test('should list the plans at the head with the standing each has there', async () => {
    const { repo, base } = await createRepo()
    const approved = join(repo, 'docs/plans/comments/plan.json')
    await mkdir(dirname(approved), { recursive: true })
    await writeFile(approved, JSON.stringify(loadApprovedCommentsPlan()), 'utf8')
    const hash = await approvePlanFile(approved)
    const head = await commit(repo, { 'draft.plan.json': JSON.stringify(loadCommentsPlan()), 'docs/plans/broken/plan.json': '{' })

    const report = await laneOf(repo, base, head)

    expect(report.plans).toEqual([
      { file: 'docs/plans/broken/plan.json', hash: '', standing: 'unreadable' },
      { file: 'docs/plans/comments/plan.json', hash, standing: 'open' },
      expect.objectContaining({ file: 'draft.plan.json', standing: 'draft' }),
    ])
  })
})

describe('change:lane', () => {
  test('should refuse to run without both commits', async () => {
    await expect(runCommand(builtinSubCommands['change:lane'], { rawArgs: ['--head', 'abc1234'] })).rejects.toThrow('needs both --base <sha> and --head <sha>')
  })

  test('should render the floor, the facts by lane and what was not judged', async () => {
    const report = await laneAfter({ 'app/Http/Controllers/PostController.ts': 'export class PostController {\n  index() {}\n}\n', 'tests/helpers.test.ts': null })

    const text = renderChangeLane(report)

    expect(text).toContain(`Change ${report.mergeBase.slice(0, 12)}..${report.head.slice(0, 12)}: floor high`)
    expect(text.indexOf('\nhigh\n')).toBeLessThan(text.indexOf('\nmedium\n'))
    expect(text).toContain('  test-removed: tests/helpers.test.ts deleted')
    expect(text).toContain('  security-records (medium): ')
  })
})
