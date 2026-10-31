import { afterEach, beforeEach, expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { createDevCenterHandler } from '../src/dev-center'
import { STATIC_PAGE_POLICY } from '../src/dev-center-review'
import { readPlanFile } from '../src/plan-render'
import { planDigest } from '../src/plan/identity'
import { renderPlanHtml } from '../src/plan/render'
import { readSavedPlanFeedback, writeSavedPlanFeedback } from '../src/plan/saved-feedback'
import { createTempWorkspace, writeWorkspaceFiles, type TempWorkspace } from './helpers'
import { loadCommentsPlan } from './plan-fixture'
import { planPageModule } from './plan-page-dom'

const PLAN = 'docs/plans/comments.plan.json'
const PAGE = 'docs/plans/comments.plan.html'
const ORIGIN = 'http://localhost:3000'

let workspace: TempWorkspace
let digest: string

beforeEach(async () => {
  workspace = await createTempWorkspace('guren-dev-center-review-')
  await writeWorkspaceFiles(workspace.dir, { [PLAN]: JSON.stringify(loadCommentsPlan()) })
  const { plan } = await readPlanFile(PLAN, workspace.dir)
  digest = planDigest(plan)
  await writeWorkspaceFiles(workspace.dir, { [PAGE]: renderPlanHtml({ plan, planFile: PLAN }) })
})

afterEach(async () => {
  await workspace.cleanup()
})

const handler = () => createDevCenterHandler({ cwd: workspace.dir, graph: async () => { throw new Error('not read') } })
const get = (path: string) => handler().fetch(new Request(`${ORIGIN}${path}`))
const post = (body: unknown, headers: Record<string, string> = { origin: ORIGIN, 'content-type': 'application/json' }) =>
  handler().fetch(new Request(`${ORIGIN}/_guren/plans/comments/feedback`, { method: 'POST', headers, body: JSON.stringify(body) }))
const feedback = { answers: [{ questionId: 'Q-delete', option: 'soft' }], elements: [{ elementId: 'column.comment.body', verdict: 'approve', comment: 'fine' }] }

test('the template declares the policy the review swaps', () => {
  expect(planPageModule('index.html')).toContain(STATIC_PAGE_POLICY)
})

test('the review serves the rendered page with connect-src added, and refuses framing', async () => {
  const response = await get('/_guren/plans/comments/review')
  expect(response.status).toBe(200)
  expect(response.headers.get('content-security-policy')).toBe("frame-ancestors 'none'")
  expect(response.headers.get('cache-control')).toBe('no-store')
  const html = await response.text()
  expect(html).toContain("img-src data:; connect-src 'self';")
  expect(html).not.toContain(STATIC_PAGE_POLICY)
})

test('the review sends a page rendered from another version, or none, back to plan:render', async () => {
  await writeWorkspaceFiles(workspace.dir, { [PLAN]: JSON.stringify({ ...loadCommentsPlan(), title: 'Edited' }) })
  const stale = await get('/_guren/plans/comments/review')
  expect(stale.status).toBe(409)
  expect(await stale.text()).toContain('bunx guren plan:render docs/plans/comments.plan.json')

  await writeWorkspaceFiles(workspace.dir, { [PAGE]: '<html></html>' })
  expect(await (await get('/_guren/plans/comments/review')).text()).toContain('older Guren CLI')
  expect((await get('/_guren/plans/nothing/review')).status).toBe(404)
})

test('feedback is saved against the plan as it stands, and read back', async () => {
  const saved = await post({ planDigest: digest, feedback })
  expect(saved.status).toBe(200)
  expect((await readSavedPlanFeedback(workspace.dir, 'comments')).saved).toMatchObject({ planDigest: digest, feedback })
  expect(await readFile(join(workspace.dir, '.guren/plans/.gitignore'), 'utf8')).toContain('*.feedback.json')

  const read = await (await get('/_guren/plans/comments/feedback')).json() as { planDigest: string; saved: { feedback: unknown } }
  expect(read.planDigest).toBe(digest)
  expect(read.saved.feedback).toEqual(feedback)
})

test('feedback is refused from another origin, in another type, off its schema, too large, or for another version', async () => {
  expect((await post({ planDigest: digest, feedback }, { origin: 'http://evil.test', 'content-type': 'application/json' })).status).toBe(403)
  expect((await post({ planDigest: digest, feedback }, { 'content-type': 'application/json' })).status).toBe(403)
  expect((await post({ planDigest: digest, feedback }, { origin: ORIGIN, 'content-type': 'text/plain' })).status).toBe(415)
  expect((await post({ planDigest: digest, feedback: { elements: 'all' } })).status).toBe(400)
  expect((await post({ planDigest: digest, feedback: { ...feedback, elements: [{ elementId: 'x', verdict: 'approve', comment: 'a'.repeat(6 * 1024 * 1024) }] } })).status).toBe(413)
  const moved = await post({ planDigest: 'not-this-plan', feedback })
  expect(moved.status).toBe(409)
  expect(await moved.json()).toMatchObject({ error: { code: 'plan-changed' } })
  expect((await readSavedPlanFeedback(workspace.dir, 'comments')).saved).toBeUndefined()
})

test('feedback refuses a slug two plans share, and the review takes only its own methods', async () => {
  await writeWorkspaceFiles(workspace.dir, { 'docs/plans/comments/plan.json': JSON.stringify(loadCommentsPlan()) })
  expect((await post({ planDigest: digest, feedback })).status).toBe(409)
  const put = await handler().fetch(new Request(`${ORIGIN}/_guren/plans/comments/review`, { method: 'POST' }))
  expect(put.status).toBe(405)
  expect(put.headers.get('allow')).toBe('GET')
})

test('the plan overview counts the saved review and says whether it names the plan as it stands', async () => {
  await writeSavedPlanFeedback(workspace.dir, 'comments', digest, { answers: [], elements: [{ elementId: 'column.comment.body', verdict: 'changes', comment: 'longer' }] })
  const overview = await (await get('/_guren/plans.json')).json() as { plans: Array<{ feedback?: Record<string, unknown> }> }
  expect(overview.plans[0]!.feedback).toMatchObject({ current: true, approved: 0, changes: 1, comments: 1, answers: 0 })

  await writeSavedPlanFeedback(workspace.dir, 'comments', 'older', { answers: [], elements: [] })
  const later = await (await get('/_guren/plans.json')).json() as { plans: Array<{ feedback?: Record<string, unknown> }> }
  expect(later.plans[0]!.feedback).toMatchObject({ current: false })
})
