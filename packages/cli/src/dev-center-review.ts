/**
 * The plan review in the Dev Center (RFC 0030 §8, served mode): the page `plan:render` wrote, served
 * at `/_guren/plans/<slug>/review`, and `/_guren/plans/<slug>/feedback`, the Dev Center's one write.
 * A slug is looked up among the discovered plans, never joined into a path.
 */

import { readFile } from 'node:fs/promises'

import { CliError, formatSchemaIssues } from './cli-error'
import type { ReviewRoute } from './dev-center-links'
import { toPosixRelative } from './discovery'
import { escapeHtml } from './docs-render'
import { planCommand } from './docs-viewer-plans'
import { discoverPlanFiles } from './plan-check'
import { readPlanFile } from './plan-render'
import { planOutputPath } from './plan/beside'
import { readWithinLimit } from './plan/feedback'
import { planDigest } from './plan/identity'
import { renderedPlanDigest } from './plan/render'
import { readSavedPlanFeedback, savedFeedbackFile, SavedFeedbackPostSchema, writeSavedPlanFeedback } from './plan/saved-feedback'
import { planSlug } from './plan/state'

/** The policy `plan/page/index.html` declares, and the one the review serves: the same plus `connect-src 'self'`. */
export const STATIC_PAGE_POLICY = `default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; form-action 'none'; base-uri 'none'; require-trusted-types-for 'script'`
const SERVED_PAGE_POLICY = STATIC_PAGE_POLICY.replace(`img-src data:;`, `img-src data:; connect-src 'self';`)

const NO_STORE = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }

function problem(status: number, code: string, message: string): Response {
  return Response.json({ schemaVersion: 1, error: { code, message } }, { status, headers: NO_STORE })
}

/** The plan a slug names. Throws the response for none or for two, which the handler returns. */
async function locate(cwd: string, slug: string): Promise<{ path: string; file: string; digest: string }> {
  const files = (await discoverPlanFiles(cwd)).files.filter((file) => planSlug(file) === slug)
  if (files.length === 0) throw problem(404, 'no-plan', 'No plan has this name.')
  if (files.length > 1) throw problem(409, 'shared-slug', `${files.length} plans share this name, so feedback could reach the wrong one; rename one of them.`)
  const path = files[0]!
  const { plan } = await readPlanFile(path, cwd)
  return { path, file: toPosixRelative(cwd, path), digest: planDigest(plan) }
}

function notServed(file: string, reason: string): Response {
  const render = escapeHtml(planCommand('plan:render', file))
  const body = `<!doctype html><meta charset="utf-8"><title>Plan review</title><p>${reason}</p><p>Run <code>${render}</code>, then reload this page.</p>`
  return new Response(body, { status: 409, headers: { ...NO_STORE, 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'" } })
}

async function servePage(cwd: string, slug: string): Promise<Response> {
  const located = await locate(cwd, slug)
  let html: string
  try {
    html = await readFile(planOutputPath(located.path), 'utf8')
  } catch {
    return notServed(located.file, 'This plan has no rendered page yet.')
  }
  // A header cannot loosen the policy the page declares, so the declared one is replaced, once.
  const at = html.indexOf(STATIC_PAGE_POLICY)
  const rendered = renderedPlanDigest(html)
  if (at < 0 || html.includes(STATIC_PAGE_POLICY, at + 1) || rendered === undefined) return notServed(located.file, 'The page was rendered by an older Guren CLI.')
  if (rendered !== located.digest) return notServed(located.file, 'The page was rendered from another version of the plan.')
  return new Response(html.slice(0, at) + SERVED_PAGE_POLICY + html.slice(at + STATIC_PAGE_POLICY.length), {
    headers: { ...NO_STORE, 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': "frame-ancestors 'none'" },
  })
}

/** The review saved for the plan as it stands, or `null`: one saved on another version is not this plan's. */
async function readFeedback(cwd: string, slug: string): Promise<Response> {
  const located = await locate(cwd, slug)
  const { saved, unreadable } = await readSavedPlanFeedback(cwd, slug)
  if (unreadable) return problem(503, 'unreadable', unreadable)
  const current = saved?.planDigest === located.digest ? saved : null
  return Response.json({ schemaVersion: 1, file: savedFeedbackFile(slug), saved: current }, { headers: NO_STORE })
}

async function saveFeedback(cwd: string, slug: string, request: Request): Promise<Response> {
  // Apps without auth have no CSRF middleware, so this is what stops another site posting here.
  if (request.headers.get('origin') !== new URL(request.url).origin) return problem(403, 'origin', 'Feedback is accepted from the Dev Center page only.')
  if (!/^application\/json\b/i.test(request.headers.get('content-type') ?? '')) return problem(415, 'content-type', 'Send the feedback as application/json.')
  let text: string
  try {
    text = request.body ? await readWithinLimit(request.body, 'feedback', 'the request') : ''
  } catch (error) {
    if (error instanceof CliError) return problem(413, 'too-large', 'The feedback is larger than a review can be.')
    throw error
  }
  let body: unknown
  try { body = JSON.parse(text) } catch { return problem(400, 'json', 'The feedback is not JSON.') }
  const parsed = SavedFeedbackPostSchema.safeParse(body)
  if (!parsed.success) return problem(400, 'schema', `The feedback does not match its schema:\n${formatSchemaIssues(parsed.error)}`)
  const located = await locate(cwd, slug)
  if (parsed.data.planDigest !== located.digest) {
    return problem(409, 'plan-changed', `The plan changed after this page was rendered. Run ${planCommand('plan:render', located.file)} and review the new page.`)
  }
  try {
    const { savedAt } = await writeSavedPlanFeedback(cwd, slug, located.digest, parsed.data.feedback)
    return Response.json({ schemaVersion: 1, savedAt }, { headers: NO_STORE })
  } catch (error) {
    return problem(503, 'write-failed', `The review could not be written to .guren/plans/ (${(error as NodeJS.ErrnoException).code ?? 'write error'}).`)
  }
}

/** A request on the path `reviewRoute()` read as `route`. */
export async function handleReviewRequest(cwd: string, request: Request, route: ReviewRoute): Promise<Response> {
  const allowed = route.resource === 'feedback' ? ['GET', 'POST'] : ['GET']
  if (!allowed.includes(request.method)) return new Response('Method not allowed', { status: 405, headers: { ...NO_STORE, Allow: allowed.join(', ') } })
  try {
    if (route.resource === 'review') return await servePage(cwd, route.slug)
    return request.method === 'POST' ? await saveFeedback(cwd, route.slug, request) : await readFeedback(cwd, route.slug)
  } catch (error) {
    if (error instanceof Response) return error
    return problem(503, 'read-failed', 'The plan could not be read.')
  }
}
