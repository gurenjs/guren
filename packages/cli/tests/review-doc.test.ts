import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { judgeChangeLane } from '../src/change/lane'
import { openChange, resolveChange } from '../src/change/resolve'
import { buildReviewBlock, renderReviewDoc, syncReviewDoc, type ReviewFacts } from '../src/change/review-doc'
import { reviewDocAuthorText } from '../src/change/review-markers'
import { APPLICATION_GRAPH_RELATIONS_FIXTURE } from './application-graph-fixture'
import { createTempRoot, createTempWorkspace, linkWorkspaceCore, writeWorkspaceFiles } from './helpers'

// The application cases introspect the fixture in a child, past Bun's 5 s default under a loaded suite.
setDefaultTimeout(60_000)

let ROOT: string
let repos = 0

beforeAll(async () => {
  ROOT = await createTempRoot('guren-review-doc-')
})

afterAll(async () => {
  await rm(ROOT, { recursive: true, force: true })
})

const FACTS: ReviewFacts = {
  policyPaths: { high: ['app/Billing/**'], medium: [] },
  models: [{ model: 'User', file: 'app/Models/User.ts', columns: ['passwordHash'] }],
  routes: [{ method: 'POST', path: '/posts', name: 'posts.store', action: 'PostController.store', middleware: ['auth'], authentication: 'required', authorizes: ['PostPolicy'] }],
  tools: [{ tool: 'posts_store', method: 'POST', path: '/posts', readOnly: false, destructive: false, ability: 'create' }],
  gaps: [],
}

const USER_FILES: Record<string, string> = {
  'app/Models/User.ts': "import { users } from '../../db/schema'\nexport class User { static table = users; static hidden = ['rememberToken'] }\n",
  'db/schema.ts': "import { pgTable, serial, text } from '@guren/orm/drizzle/pg'\nexport const users = pgTable('users', { id: serial('id').primaryKey(), email: text('email'), passwordHash: text('password_hash'), rememberToken: text('remember_token') })\n",
}

describe('buildReviewBlock', () => {
  test('should list what a reviewer reads, row by row', () => {
    const block = buildReviewBlock(FACTS).join('\n')

    expect(block).toContain('`guren.review.ts`')
    expect(block).toContain('- a path `guren.review.ts` puts at `high`: `app/Billing/**`')
    expect(block).toContain('| User | app/Models/User.ts | passwordHash |')
    expect(block).toContain('| POST | /posts | posts.store | PostController.store | auth | required | PostPolicy |')
    expect(block).toContain('| posts_store | POST /posts | no | no | create |')
    expect(block.split('\n').some((line) => line.startsWith('#'))).toBe(false)
  })

  test('should say what it could not read instead of an empty table', () => {
    const block = buildReviewBlock({ ...FACTS, policyPaths: { unreadable: 'paths.high (line 3) is the name HIGH' }, routes: { unreadable: 'the routes were not registered (no-entry)' }, tools: [], gaps: ['authorizes: boot-bound-policy'] }).join('\n')

    expect(block).toContain('could not be read, so every change is held at `high`: paths.high (line 3) is the name HIGH')
    expect(block).toContain('Not read: the routes were not registered (no-entry)')
    expect(block).toContain('- authorizes: boot-bound-policy')
  })
})

describe('renderReviewDoc', () => {
  test('should replace only the generated block and keep the author\'s rules', () => {
    const first = renderReviewDoc(undefined, ['old'])
    if (!('content' in first)) throw new Error(first.problems.join('; '))
    const edited = first.content.replace('- A change to authentication', '- Every migration is read twice.\n- A change to authentication')

    const second = renderReviewDoc(edited, ['new'])

    expect('content' in second && second.content).toBe(edited.replace('\nold\n', '\nnew\n'))
  })

  test('should refuse markers it cannot rewrite safely', () => {
    expect(renderReviewDoc('# Review\n\n<!-- guren:review generated -->\nunclosed\n', ['x'])).toEqual({ problems: [expect.stringContaining('opens and never closes')] })
  })

  test('should compare two versions on the author\'s text alone', () => {
    const doc = (block: string, rule: string): string => `# Review\n\n- ${rule}\n\n## What this application holds\n\n<!-- guren:review generated -->\n${block}\n<!-- /guren:review generated -->\n`

    expect(reviewDocAuthorText(doc('a', 'rule'))).toBe(reviewDocAuthorText(doc('b', 'rule')))
    expect(reviewDocAuthorText(doc('a', 'rule'))).not.toBe(reviewDocAuthorText(doc('a', 'other rule')))
    expect(reviewDocAuthorText('<!-- guren:review generated -->\n')).toBeUndefined()
  })
})

describe('syncReviewDoc', () => {
  test('should write the block from the application, then call it current, then stale once a route is added', async () => {
    const workspace = await createTempWorkspace('guren-review-doc-app-')
    try {
      await linkWorkspaceCore(workspace.dir)
      await writeWorkspaceFiles(workspace.dir, { ...APPLICATION_GRAPH_RELATIONS_FIXTURE, ...USER_FILES })

      expect(await syncReviewDoc(workspace.dir, { check: true })).toMatchObject({ state: 'missing' })
      expect(await syncReviewDoc(workspace.dir)).toMatchObject({ state: 'written', gaps: ['usesMiddleware: inline-middleware', 'authorizes: boot-bound-policy'] })
      const written = await readFile(join(workspace.dir, 'REVIEW.md'), 'utf8')
      expect(written).toContain('| User | app/Models/User.ts | passwordHash, rememberToken |')
      expect(written).toContain('| POST | /posts | posts.store | PostController.store | auth, stamp (inline) | not required | PostPolicy |')
      expect(written).toContain('| PUT | /posts/:post | posts.update | PostController.update |  | not required | PostPolicy (through the gate) |')
      expect(written).not.toContain(workspace.dir)
      expect(await syncReviewDoc(workspace.dir, { check: true })).toMatchObject({ state: 'unchanged' })

      const main = APPLICATION_GRAPH_RELATIONS_FIXTURE['src/main.ts']!.replace(".name('posts.update')", ".name('posts.update')\n  router.delete('/posts/:post', [PostController, 'update']).name('posts.destroy')")
      await writeWorkspaceFiles(workspace.dir, { 'src/main.ts': main })
      expect(await syncReviewDoc(workspace.dir, { check: true })).toMatchObject({ state: 'stale' })
      expect(await readFile(join(workspace.dir, 'REVIEW.md'), 'utf8')).toBe(written)
    } finally {
      await workspace.cleanup()
    }
  })
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

describe('change:lane on REVIEW.md', () => {
  const doc = (block: string, rule: string): string => `# Review\n\n## Rules\n\n- ${rule}\n\n## What this application holds\n\n<!-- guren:review generated -->\n${block}\n<!-- /guren:review generated -->\n`

  async function laneOf(head: string) {
    const repo = join(ROOT, `repo-${repos++}`)
    await mkdir(repo, { recursive: true })
    await git(repo, ['init', '--initial-branch=main'])
    await git(repo, ['config', 'user.email', 'test@example.com'])
    await git(repo, ['config', 'user.name', 'Test'])
    const base = await commit(repo, { 'package.json': '{"name":"app"}', 'REVIEW.md': doc('one route', 'Read every policy.') })
    const change = await resolveChange(repo, base, await commit(repo, { 'REVIEW.md': head }))
    const { reader, dispose } = openChange(repo, change)
    try {
      return await judgeChangeLane(change, reader)
    } finally {
      await dispose()
    }
  }

  test('should read an edit to the rules as high and a regenerated block as medium', async () => {
    expect((await laneOf(doc('one route', 'Policies need no reading.'))).facts.map(({ code, lane }) => [code, lane])).toEqual([['gate-input', 'high']])
    expect((await laneOf(doc('two routes', 'Read every policy.'))).facts.map(({ code, lane }) => [code, lane])).toEqual([['source-edited', 'medium']])
    expect((await laneOf('<!-- guren:review generated -->\n')).facts.map(({ code, lane }) => [code, lane])).toEqual([['gate-input', 'high']])
  })
})
