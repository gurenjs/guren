import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { BrowserRun } from '../src/browser-record'
import { createDevCenterHandler } from '../src/dev-center'
import type { PlanEvidence } from '../src/dev-center-evidence'
import { browserScreenshotPath, browserScreenshotRoute, planEvidenceSlug } from '../src/dev-center-links'
import { readPlanFile } from '../src/plan-render'
import { planDigest, writePlanStepRecord } from '../src/plan/state'
import { sha256 } from '../src/plan/verification'
import { createTempWorkspace, writeWorkspaceFiles, type TempWorkspace } from './helpers'
import { loadCommentsPlan } from './plan-fixture'

const PLAN = 'docs/plans/comments.plan.json'
const ORIGIN = 'http://localhost:3000'
const RUN = '2026-10-31T09-00-00Z-posts'
const SHOT = Buffer.from('not really a png')

let workspace: TempWorkspace

function run(steps: BrowserRun['steps'], feature = 'posts', name = RUN): BrowserRun {
  return { schemaVersion: 1, run: name, origin: 'http://127.0.0.1:4317', feature, graphSnapshot: null, commit: { rev: 'abcdef1234567890', dirty: false }, steps, open: {} }
}
function browserStep(id: string, screenshots: BrowserRun['steps'][number]['cli']['screenshots'] = []): BrowserRun['steps'][number] {
  return { id, result: 'pass', recorder: { result: 'pass', action: 'Posted a comment' }, cli: { screenshots, runtimeErrors: { window: 'conclusive', events: 0 } } }
}
async function writeRun(value: BrowserRun, dir = value.run): Promise<void> {
  await mkdir(join(workspace.dir, '.guren/browser', dir, 'screenshots'), { recursive: true })
  await writeFile(join(workspace.dir, '.guren/browser', dir, 'run.json'), JSON.stringify(value))
}

beforeEach(async () => {
  workspace = await createTempWorkspace('guren-dev-center-evidence-')
  await writeWorkspaceFiles(workspace.dir, { [PLAN]: JSON.stringify(loadCommentsPlan()) })
})

afterEach(async () => {
  await workspace.cleanup()
})

const get = (path: string) => createDevCenterHandler({ cwd: workspace.dir, graph: async () => { throw new Error('not read') } }).fetch(new Request(`${ORIGIN}${path}`))
const evidence = async () => {
  const response = await get('/_guren/plans/comments/evidence')
  expect(response.status).toBe(200)
  expect(response.headers.get('cache-control')).toBe('no-store')
  return await response.json() as PlanEvidence
}
const stepOf = (read: PlanEvidence, suffix: string) => read.steps.find((step) => step.id.endsWith(`/${suffix}`))!

test('evidence names each step\'s plan routes, and none for a step that touches no route', async () => {
  const read = await evidence()
  expect(read.file).toBe(PLAN)
  expect(stepOf(read, 'http').routes.map((route) => `${route.method} ${route.path}`)).toEqual(['POST /posts/:postId/comments', 'DELETE /comments/:id'])
  expect(stepOf(read, 'pages').features).toEqual(['posts'])
  expect(stepOf(read, 'scaffold').routes).toEqual([])
  expect(read.runs).toEqual({ read: 0, skipped: 0, unreadable: [] })
})

test('evidence carries the step\'s last plan:verify record, its fingerprinted files and work', async () => {
  const { plan } = await readPlanFile(PLAN, workspace.dir)
  const id = stepOf(await evidence(), 'http').id
  await writePlanStepRecord(workspace.dir, 'comments', id, {
    outcome: 'verified', planDigest: planDigest(plan), ranAt: '2026-10-31T10:00:00.000Z', durationMs: 1, commands: [], acceptance: [], incomplete: [], waived: [],
    fingerprint: { files: { 'routes/comments.ts': 'a', 'app/Http/Controllers/CommentController.ts': 'b' }, environment: { runtime: 'bun', platform: 'darwin', arch: 'arm64', hostname: 'test' } },
    work: { measured: true, from: '0123456789abcdef', files: [{ path: 'routes/comments.ts', added: 12, removed: 0 }], added: 12, removed: 0, settled: true },
  })
  const record = stepOf(await evidence(), 'http').record
  expect(record).toMatchObject({ outcome: 'verified', current: true, files: ['app/Http/Controllers/CommentController.ts', 'routes/comments.ts'], work: { measured: true, added: 12 } })
})

test('evidence lists browser steps by acceptance id, and a run of a feature the step renders', async () => {
  await writeRun(run([browserStep('AC-comments-1'), browserStep('charter-scroll')]))
  await writeRun(run([browserStep('AC-comments-2')], 'settings', '2026-10-30T09-00-00Z-settings'))
  const read = await evidence()
  expect(stepOf(read, 'http').browser.map((entry) => [entry.run, entry.step.id, entry.match])).toEqual([[RUN, 'AC-comments-1', 'acceptance'], ['2026-10-30T09-00-00Z-settings', 'AC-comments-2', 'acceptance']])
  expect(stepOf(read, 'pages').browser.map((entry) => [entry.step.id, entry.match])).toEqual([['AC-comments-1', 'feature'], ['charter-scroll', 'feature']])
  expect(stepOf(read, 'scaffold').browser).toEqual([])
})

test('evidence reports a run that would not read, or that was copied from another, and keeps the others', async () => {
  await writeRun(run([browserStep('AC-comments-1')]))
  await writeRun(run([], 'posts', '2026-10-29T09-00-00Z-posts'), '2026-10-29T09-00-01Z-posts')
  await mkdir(join(workspace.dir, '.guren/browser/2026-10-28T09-00-00Z-posts'), { recursive: true })
  await writeFile(join(workspace.dir, '.guren/browser/2026-10-28T09-00-00Z-posts/run.json'), '{')
  await mkdir(join(workspace.dir, '.guren/browser/not-a-run'), { recursive: true })
  const read = await evidence()
  expect(read.runs.read).toBe(1)
  expect(read.runs.unreadable.map((entry) => entry.run)).toEqual(['2026-10-29T09-00-01Z-posts', '2026-10-28T09-00-00Z-posts'])
})

test('evidence refuses a slug two plans share, and a plan that does not exist', async () => {
  expect((await get('/_guren/plans/nothing/evidence')).status).toBe(404)
  await writeWorkspaceFiles(workspace.dir, { 'docs/plans/comments/plan.json': JSON.stringify(loadCommentsPlan()) })
  const shared = await get('/_guren/plans/comments/evidence')
  expect(shared.status).toBe(409)
  expect(await shared.json()).toMatchObject({ error: { code: 'shared-slug' } })
})

test('a screenshot is served by its run and digest while its bytes still hash to it', async () => {
  const digest = sha256(SHOT)
  await writeRun(run([browserStep('AC-comments-1', [{ path: 'screenshots/after.png', sha256: digest }])]))
  await writeFile(join(workspace.dir, '.guren/browser', RUN, 'screenshots/after.png'), SHOT)
  const served = await get(browserScreenshotPath(RUN, digest))
  expect(served.status).toBe(200)
  expect(served.headers.get('content-type')).toBe('image/png')
  expect(served.headers.get('x-content-type-options')).toBe('nosniff')
  expect(Buffer.from(await served.arrayBuffer()).equals(SHOT)).toBe(true)

  expect((await get(browserScreenshotPath(RUN, '0'.repeat(64)))).status).toBe(404)
  expect((await get(browserScreenshotPath('2026-10-31T09-00-00Z-other', digest))).status).toBe(404)
  expect((await get(`/_guren/browser/..%2F..%2Fdocs/screenshots/${digest}`)).status).toBe(404)
  await writeFile(join(workspace.dir, '.guren/browser', RUN, 'screenshots/after.png'), 'edited')
  expect((await get(browserScreenshotPath(RUN, digest))).status).toBe(409)
})

test('a screenshot recorded outside screenshots/, or of a type the page does not show, is not served', async () => {
  const digest = sha256(SHOT)
  await writeRun(run([browserStep('a', [{ path: 'run.json', sha256: digest }]), browserStep('b', [{ path: 'screenshots/page.html', sha256: sha256(Buffer.from('<p>')) }])]))
  await writeFile(join(workspace.dir, '.guren/browser', RUN, 'screenshots/page.html'), '<p>')
  expect((await get(browserScreenshotPath(RUN, digest))).status).toBe(404)
  expect((await get(browserScreenshotPath(RUN, sha256(Buffer.from('<p>'))))).status).toBe(404)
})

test('the evidence and screenshot paths read one segment each', () => {
  expect(planEvidenceSlug('/_guren/plans/a%20b/evidence')).toBe('a b')
  expect(planEvidenceSlug('/_guren/plans/a/b/evidence')).toBeUndefined()
  expect(browserScreenshotRoute(`/_guren/browser/${RUN}/screenshots/${'a'.repeat(64)}`)).toEqual({ run: RUN, sha256: 'a'.repeat(64) })
  expect(browserScreenshotRoute(`/_guren/browser/${RUN}/screenshots/${'A'.repeat(64)}`)).toBeUndefined()
  expect(browserScreenshotRoute(`/_guren/browser/${RUN}/screenshots/after.png`)).toBeUndefined()
})

test('the shell lets the page show images from its own origin only', async () => {
  const shell = await get('/_guren/plans/comments')
  expect(shell.headers.get('content-security-policy')).toContain("img-src 'self';")
})
