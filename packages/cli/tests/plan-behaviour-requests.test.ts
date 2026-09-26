import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { readBracketedTokenFiles } from '../src/docs-acceptance'
import { ParseCache } from '../src/parse-cache'
import { behaviourRequestFailure, judgeBehaviourRequests, type BehaviourRequestFindings } from '../src/plan/behaviour-requests'
import { PlanDraftSchema, type PlanDraft } from '../src/plan/schema'
import { scanTestCaseRequests } from '../src/test-requests'
import { writeWorkspaceFiles } from './helpers'
import { loadCommentsPlan } from './plan-fixture'

let ROOT: string
let counter = 0
let plan: PlanDraft
let agentPlan: PlanDraft

const HEAD = "import { describe, expect, test } from 'bun:test'\nimport { TestApp } from '@guren/testing'\nimport application from '../src/app'\n\nconst app = TestApp.fromApp(application)\n"
const STORE = 'POST /posts/:postId/comments'

async function judge(files: Record<string, string>, ids: string[], against: PlanDraft = plan): Promise<BehaviourRequestFindings> {
  counter += 1
  const dir = join(ROOT, `app-${counter}`)
  await writeWorkspaceFiles(dir, files)
  const absolute = Object.keys(files).map((file) => join(dir, file))
  const wanted = new Set(ids)
  const carriers = await readBracketedTokenFiles(dir, absolute, (token) => wanted.has(token))
  const scan = await scanTestCaseRequests(dir, absolute, new ParseCache(), (token) => wanted.has(token))
  return judgeBehaviourRequests(against, ids, scan, carriers)
}

const one = (source: string, ids = ['AC-comments-1']): Promise<BehaviourRequestFindings> => judge({ 'tests/comments.test.ts': source }, ids)

beforeAll(async () => {
  ROOT = await mkdtemp(join(tmpdir(), 'guren-behaviour-requests-'))
  plan = PlanDraftSchema.parse(loadCommentsPlan())
  const document = loadCommentsPlan() as { routes: Array<{ id: string; agent?: unknown }> }
  document.routes.find((route) => route.id === 'route.comments.destroy')!.agent = { toolName: 'comments_destroy', readOnly: false }
  agentPlan = PlanDraftSchema.parse(document)
})

afterAll(async () => {
  await rm(ROOT, { recursive: true, force: true })
})

describe('judgeBehaviourRequests', () => {
  test('should pass a behaviour whose test requests the route it names, through a runtime segment too', async () => {
    const result = await one(`${HEAD}
const postId = 1
test('[AC-comments-1] a signed-in user can comment', async () => {
  await app.post(\`/posts/\${postId}/comments\`, { body: 'hi' }).assertRedirect()
})
`)
    expect(result).toEqual({ misses: [], unreadable: [] })
    expect(behaviourRequestFailure(result)).toBeUndefined()
  })

  test('should fail a behaviour whose test requests another route, naming both', async () => {
    const result = await one(`${HEAD}
test('[AC-comments-1] a signed-in user can comment', async () => {
  await app.get('/posts/1').assertOk()
})
`)
    expect(result.misses).toEqual([`[AC-comments-1] no test carrying it requests ${STORE}: tests/comments.test.ts:7 requests GET /posts/1`])
    expect(behaviourRequestFailure(result)?.reason).toBe('a behaviour\'s test does not request the route the behaviour names')
  })

  test('should fail a behaviour whose test requests nothing', async () => {
    const result = await one(`${HEAD}
test('[AC-comments-1] a signed-in user can comment', () => {
  expect(true).toBe(false)
})
`)
    expect(result.misses).toEqual([`[AC-comments-1] no test carrying it requests ${STORE}: tests/comments.test.ts:7 requests nothing`])
  })

  test('should judge each case apart: another case of the file requesting the route does not cover the one carrying the id', async () => {
    const result = await one(`${HEAD}
test('an unrelated case', async () => {
  await app.post('/posts/1/comments', { body: 'hi' })
})
test('[AC-comments-1] a signed-in user can comment', () => {
  expect(true).toBe(false)
})
`)
    expect(result.misses).toEqual([`[AC-comments-1] no test carrying it requests ${STORE}: tests/comments.test.ts:10 requests nothing`])
  })

  test('should credit a describe carrying the id with the requests of the cases inside it', async () => {
    const result = await one(`${HEAD}
describe('[AC-comments-1] a signed-in user can comment', () => {
  test('redirects back to the post', async () => {
    await app.post('/posts/1/comments', { body: 'hi' }).assertRedirect()
  })
})
`)
    expect(result).toEqual({ misses: [], unreadable: [] })
  })

  test('should follow a same-file function the case calls by name', async () => {
    const result = await one(`${HEAD}
async function comment(client: TestApp, body: string) {
  return client.post('/posts/1/comments', { body })
}
test('[AC-comments-1] a signed-in user can comment', async () => {
  await comment(app, 'hi')
})
`)
    expect(result).toEqual({ misses: [], unreadable: [] })
  })

  test('should report a request through an imported helper as unreadable, never as a miss', async () => {
    const result = await one(`${HEAD}
import { signedIn } from './helpers'
test('[AC-comments-1] a signed-in user can comment', async () => {
  await (await signedIn()).post('/posts/1/comments', { body: 'hi' })
})
`)
    expect(result.misses).toEqual([])
    expect(result.unreadable).toEqual([`[AC-comments-1] cannot tell whether its test requests ${STORE}: tests/comments.test.ts:9 POST /posts/1/comments (a request on what an imported helper returns)`])
    expect(behaviourRequestFailure(result)?.reason).toBe('a behaviour\'s test requests its route in a way this check cannot read: spell the request in the test')
  })

  test('should report a case handing its TestApp to an imported function as unreadable', async () => {
    const result = await one(`${HEAD}
import { comment } from './helpers'
test('[AC-comments-1] a signed-in user can comment', async () => {
  await comment(app, 'hi')
})
`)
    expect(result.unreadable).toEqual([`[AC-comments-1] cannot tell whether its test requests ${STORE}: tests/comments.test.ts:9 hands the TestApp to comment(…)`])
  })

  test('should not count an unresolved request of another method as a possible reach', async () => {
    const result = await one(`${HEAD}
declare const path: string
test('[AC-comments-1] a signed-in user can comment', async () => {
  await app.get(path)
})
`)
    expect(result.unreadable).toEqual([])
    expect(result.misses).toEqual([`[AC-comments-1] no test carrying it requests ${STORE}: tests/comments.test.ts:8 requests nothing`])
  })

  test('should fail an id no test or describe title carries, as when it moved to a comment', async () => {
    const result = await one(`${HEAD}
// [AC-comments-1]
test('a signed-in user can comment', async () => {
  await app.post('/posts/1/comments', { body: 'hi' })
})
`)
    expect(result.misses).toEqual([`[AC-comments-1] is in no test or describe title in tests/comments.test.ts, so no test of it requests ${STORE}`])
  })

  test('should report a title it cannot read and a file that does not parse as unreadable', async () => {
    const opaque = await one(`${HEAD}
// [AC-comments-1]
const title = 'x'
test(title, () => {})
`)
    const unparsed = await one(`${HEAD}
test('[AC-comments-1] x', () => {
`)
    expect(opaque.unreadable).toEqual([`[AC-comments-1] cannot tell whether its test requests ${STORE}: tests/comments.test.ts:9 a test titled <runtime>`])
    expect(unparsed.unreadable).toEqual([`[AC-comments-1] cannot tell whether its test requests ${STORE}: tests/comments.test.ts does not parse`])
  })

  test('should pass an agent route requested through its tool, and fail another tool', async () => {
    const tool = (name: string): Promise<BehaviourRequestFindings> =>
      judge({ 'tests/comments.test.ts': `${HEAD}
test('[AC-comments-4] the author can delete', async () => {
  await app.agent().call('${name}', { id: 1 })
})
` }, ['AC-comments-4'], agentPlan)

    expect(await tool('comments_destroy')).toEqual({ misses: [], unreadable: [] })
    expect((await tool('comments_store')).misses).toEqual([
      "[AC-comments-4] no test carrying it requests DELETE /comments/:id or agent().call('comments_destroy'): tests/comments.test.ts:7 requests agent().call('comments_store')",
    ])
  })

  test('should leave an id no file carries to the test run, which reports it pending', async () => {
    expect(await one(`${HEAD}\ntest('x', () => {})\n`)).toEqual({ misses: [], unreadable: [] })
  })
})
