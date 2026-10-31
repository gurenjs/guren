/**
 * The plan review in the Dev Center (RFC 0030 §8, served mode): the page `plan:render` wrote, served
 * at `/_guren/plans/<slug>/review`, and `/_guren/plans/<slug>/feedback`, the Dev Center's one write.
 * A slug is looked up among the discovered plans, never joined into a path.
 */

import { readFile } from 'node:fs/promises'

import { formatSchemaIssues } from './cli-error'
import { toPosixRelative } from './discovery'
import { planCommand } from './docs-viewer-plans'
import { discoverPlanFiles } from './plan-check'
import { readPlanFile } from './plan-render'
import { planOutputPath } from './plan/beside'
import { FEEDBACK_MAX_BYTES } from './plan/feedback'
import { planDigest } from './plan/identity'
import { readSavedPlanFeedback, SavedFeedbackPostSchema, writeSavedPlanFeedback } from './plan/saved-feedback'
import { planSlug } from './plan/state'

const REVIEW_PATH = /^\/_guren\/plans\/([^/]+)\/(review|feedback)$/

/** The policy `plan/page/index.html` declares, and the one the review serves: the same plus `connect-src 'self'`. */
export const STATIC_PAGE_POLICY = `default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; form-action 'none'; base-uri 'none'; require-trusted-types-for 'script'`
const SERVED_PAGE_POLICY = STATIC_PAGE_POLICY.replace(`img-src data:;`, `img-src data:; connect-src 'self';`)

const NO_STORE = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }

export function reviewRoute(pathname: string): { slug: string; resource: 'review' | 'feedback' } | undefined {
  const match = REVIEW_PATH.exec(pathname)
  if (!match) return undefined
  try { return { slug: decodeURIComponent(match[1]!), resource: match[2] as 'review' | 'feedback' } } catch { return undefined }
}

function problem(status: number, code: string, message: string): Response {
  return Response.json({ schemaVersion: 1, error: { code, message } }, { status, headers: NO_STORE })
}

type Located = { path: string; file: string; digest: string } | { refusal: Response }

async function locate(cwd: string, slug: string): Promise<Located> {
  const files = (await discoverPlanFiles(cwd)).files.filter((file) => planSlug(file) === slug)
  if (files.length === 0) return { refusal: problem(404, 'no-plan', 'No plan has this name.') }
  if (files.length > 1) return { refusal: problem(409, 'shared-slug', `${files.length} plans share this name, so feedback could reach the wrong one; rename one of them.`) }
  const path = files[0]!
  const { plan } = await readPlanFile(path, cwd)
  return { path, file: toPosixRelative(cwd, path), digest: planDigest(plan) }
}

/** The digest a page was rendered at, or `undefined` for a page from a CLI that embedded none. */
function renderedDigest(html: string): string | undefined {
  const match = /<script\b[^>]*\bid="plan-data"[^>]*>([\s\S]*?)<\/script>/.exec(html)
  if (!match) return undefined
  try {
    const digest = (JSON.parse(match[1]!) as { planDigest?: unknown }).planDigest
    return typeof digest === 'string' ? digest : undefined
  } catch {
    return undefined
  }
}

const escapeHtml = (text: string): string => text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`)

function notServed(file: string, reason: string): Response {
  const render = escapeHtml(planCommand('plan:render', file))
  const body = `<!doctype html><meta charset="utf-8"><title>Plan review</title><p>${reason}</p><p>Run <code>${render}</code>, then reload this page.</p>`
  return new Response(body, { status: 409, headers: { ...NO_STORE, 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'" } })
}

async function servePage(cwd: string, slug: string): Promise<Response> {
  const located = await locate(cwd, slug)
  if ('refusal' in located) return located.refusal
  let html: string
  try {
    html = await readFile(planOutputPath(located.path), 'utf8')
  } catch {
    return notServed(located.file, 'This plan has no rendered page yet.')
  }
  // A header cannot loosen the policy the page declares, so the declared one is replaced, once.
  const sites = html.split(STATIC_PAGE_POLICY).length - 1
  if (sites !== 1 || renderedDigest(html) === undefined) return notServed(located.file, 'The page was rendered by an older Guren CLI.')
  if (renderedDigest(html) !== located.digest) return notServed(located.file, 'The page was rendered from another version of the plan.')
  return new Response(html.replace(STATIC_PAGE_POLICY, () => SERVED_PAGE_POLICY), {
    headers: { ...NO_STORE, 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': "frame-ancestors 'none'" },
  })
}

async function readFeedback(cwd: string, slug: string): Promise<Response> {
  const located = await locate(cwd, slug)
  if ('refusal' in located) return located.refusal
  const { saved, unreadable } = await readSavedPlanFeedback(cwd, slug)
  if (unreadable) return problem(503, 'unreadable', unreadable)
  return Response.json({ schemaVersion: 1, planDigest: located.digest, saved: saved ?? null }, { headers: NO_STORE })
}

async function boundedText(request: Request): Promise<string | undefined> {
  const reader = request.body?.getReader()
  if (!reader) return ''
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > FEEDBACK_MAX_BYTES) {
      await reader.cancel()
      return undefined
    }
    chunks.push(value)
  }
  return new TextDecoder().decode(Buffer.concat(chunks))
}

async function saveFeedback(cwd: string, slug: string, request: Request): Promise<Response> {
  // Apps without auth have no CSRF middleware, so this is what stops another site posting here.
  if (request.headers.get('origin') !== new URL(request.url).origin) return problem(403, 'origin', 'Feedback is accepted from the Dev Center page only.')
  if (!/^application\/json\b/i.test(request.headers.get('content-type') ?? '')) return problem(415, 'content-type', 'Send the feedback as application/json.')
  const text = await boundedText(request)
  if (text === undefined) return problem(413, 'too-large', 'The feedback is larger than a review can be.')
  let body: unknown
  try { body = JSON.parse(text) } catch { return problem(400, 'json', 'The feedback is not JSON.') }
  const parsed = SavedFeedbackPostSchema.safeParse(body)
  if (!parsed.success) return problem(400, 'schema', `The feedback does not match its schema:\n${formatSchemaIssues(parsed.error)}`)
  const located = await locate(cwd, slug)
  if ('refusal' in located) return located.refusal
  if (parsed.data.planDigest !== located.digest) {
    return problem(409, 'plan-changed', `The plan changed after this page was rendered. Run ${planCommand('plan:render', located.file)} and review the new page.`)
  }
  const saved = await writeSavedPlanFeedback(cwd, slug, located.digest, parsed.data.feedback)
  return Response.json({ schemaVersion: 1, savedAt: saved.savedAt }, { headers: NO_STORE })
}

/** `undefined` for a path that is not the review's; the caller answers those. */
export async function handleReviewRequest(cwd: string, request: Request): Promise<Response | undefined> {
  const route = reviewRoute(new URL(request.url).pathname)
  if (!route) return undefined
  const allowed = route.resource === 'feedback' ? 'GET, POST' : 'GET'
  if (!allowed.split(', ').includes(request.method)) return new Response('Method not allowed', { status: 405, headers: { ...NO_STORE, Allow: allowed } })
  try {
    if (route.resource === 'review') return await servePage(cwd, route.slug)
    return request.method === 'POST' ? await saveFeedback(cwd, route.slug, request) : await readFeedback(cwd, route.slug)
  } catch {
    return problem(503, 'read-failed', 'The plan could not be read.')
  }
}
