import { describe, expect, test } from 'bun:test'

import { planDigest } from '../src/plan/identity'
import { renderPlanHtml } from '../src/plan/render'
import { PlanDraftSchema } from '../src/plan/schema'
import { loadCommentsPlan } from './plan-fixture'
import { openPlanPage, type Page, type PageNode } from './plan-page-dom'

const PATHNAME = '/_guren/plans/comments/review'
const plan = PlanDraftSchema.parse(loadCommentsPlan())
const html = renderPlanHtml({ plan, planFile: 'docs/plans/comments.plan.json' })
const digest = planDigest(plan)

interface Call { url: string; method: string; body?: { planDigest: string; feedback: { elements: Array<{ elementId: string; verdict: string | null }> } } }

const answer = (ok: boolean, status: number, body: unknown) => Promise.resolve({ ok, status, json: () => Promise.resolve(body) })
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

/** The page served at the review path, its GET answered with `saved`, every POST handed to `onPost`. */
async function served(saved: unknown, onPost: (call: Call) => ReturnType<typeof answer> = () => answer(true, 200, { savedAt: '2026-10-31T00:00:00Z' })) {
  const calls: Call[] = []
  const timers: Array<() => void> = []
  const page = openPlanPage(html, {
    timers,
    served: {
      pathname: PATHNAME,
      fetch: (url, init) => {
        const call: Call = { url, method: init?.method ?? 'GET', ...(init?.body ? { body: JSON.parse(init.body) as Call['body'] } : {}) }
        calls.push(call)
        return call.method === 'POST' ? onPost(call) : answer(true, 200, { schemaVersion: 1, file: '.guren/plans/comments.feedback.json', saved })
      },
    },
  })
  await settle()
  const runTimers = async () => {
    for (const run of timers.splice(0)) run()
    await settle()
  }
  return { page, calls, posts: () => calls.filter((call) => call.method === 'POST'), runTimers }
}

const nodes = (page: Page): PageNode[] => page.document.body.all()
const approved = (page: Page) => nodes(page).filter((node) => (node.attributes.class ?? '').split(' ').includes('mark-approve'))
const button = (page: Page, text: string, nth = 0) => nodes(page).filter((node) => node.tag === 'button' && node.textContent === text)[nth]!

describe('the plan page served for review in the Dev Center', () => {
  test('starts from the review the server saved for this version, and ignores one saved for another', async () => {
    const feedback = { answers: [{ questionId: 'Q-delete', option: 'soft delete' }], elements: [{ elementId: 'column.comment.body', verdict: 'approve', comment: 'keep' }] }
    const { page, calls } = await served({ planDigest: digest, feedback })
    expect(calls[0]).toMatchObject({ url: '/_guren/plans/comments/feedback', method: 'GET' })
    expect(approved(page)).toHaveLength(1)
    expect(page.byId('footer-note').textContent).toContain('.guren/plans/comments.feedback.json')

    const elsewhere = await served({ planDigest: 'another-version', feedback })
    expect(approved(elsewhere.page)).toHaveLength(0)
  })

  test('posts the whole document once, a moment after a change', async () => {
    const { page, posts, runTimers } = await served(null)
    button(page, 'Approve').click()
    expect(posts()).toHaveLength(0)
    await runTimers()
    expect(posts()).toHaveLength(1)
    expect(posts()[0]!.body).toMatchObject({ planDigest: digest, feedback: { elements: [{ verdict: 'approve' }] } })
    expect(page.byId('save-status').textContent).toContain('saved')
  })

  test('posts again after a save in flight when another change arrives during it', async () => {
    let release: () => void = () => {}
    let first = true
    const { page, posts, runTimers } = await served(null, () => {
      if (!first) return answer(true, 200, {})
      first = false
      return new Promise((resolve) => { release = () => resolve({ ok: true, status: 200, json: () => Promise.resolve({}) }) })
    })
    button(page, 'Approve').click()
    await runTimers()
    button(page, 'Request changes').click()
    await runTimers()
    expect(posts()).toHaveLength(1)
    release()
    await settle()
    await runTimers()
    expect(posts()).toHaveLength(2)
    expect(posts()[1]!.body!.feedback.elements[0]).toMatchObject({ verdict: 'changes' })
  })

  test('tries an unanswered save again, and asks before leaving while a change is unsaved', async () => {
    let attempts = 0
    const { page, posts, runTimers } = await served(null, () => (++attempts === 1 ? Promise.reject(new Error('restarting')) : answer(true, 200, {})))
    button(page, 'Approve').click()
    await runTimers()
    expect(page.byId('save-status').textContent).toContain('not saved')
    expect(page.window.dispatch('beforeunload')).toBe(true)
    await runTimers()
    expect(posts()).toHaveLength(2)
    expect(page.window.dispatch('beforeunload')).toBe(false)
  })

  test('saves nothing when the saved review could not be read, so it never replaces one it did not load', async () => {
    const posts: unknown[] = []
    const timers: Array<() => void> = []
    const page = openPlanPage(html, {
      timers,
      served: {
        pathname: PATHNAME,
        fetch: (_url, init) => {
          if (init?.method === 'POST') posts.push(init.body)
          return init?.method === 'POST' ? answer(true, 200, {}) : answer(false, 503, { error: { message: 'restarting' } })
        },
      },
    })
    await settle()
    button(page, 'Approve').click()
    for (const run of timers.splice(0)) run()
    await settle()
    expect(posts).toHaveLength(0)
    expect(page.byId('save-status').textContent).toContain('could not be read')
  })

  test('posts nothing when a change leaves the document as it was saved', async () => {
    const { page, posts, runTimers } = await served(null)
    button(page, 'Approve').click()
    await runTimers()
    button(page, 'Approve').click()
    button(page, 'Approve').click()
    await runTimers()
    expect(posts()).toHaveLength(1)
  })

  test('does not retry a save the server refused', async () => {
    const { page, posts, runTimers } = await served(null, () => answer(false, 409, { error: { message: 'The plan changed after this page was rendered.' } }))
    button(page, 'Approve').click()
    await runTimers()
    await runTimers()
    expect(posts()).toHaveLength(1)
    expect(page.byId('save-status').textContent).toContain('The plan changed')
  })
})
