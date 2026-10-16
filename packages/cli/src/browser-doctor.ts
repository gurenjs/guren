/**
 * `guren browser:doctor --url` (RFC 0033 §4): does this instance serve every mapped landmark
 * without a server failure? It renders nothing and starts nothing. A pass needs a complete map,
 * a conclusive runtime-error window and at least one landmark served as the graph says; an
 * unavailable collector or an expired cursor is never read as zero errors.
 */

import { buildBrowserMap, type BrowserFeature, type BrowserMap } from './browser-map'
import { loadApplicationGraph } from './application-graph-load'
import { fetchRuntimeErrors, runtimeOrigin, type RuntimeErrorQuery, type RuntimeErrorResult } from './runtime-errors'

type RuntimeErrorEvent = Extract<RuntimeErrorResult, { status: 'available' }>['events'][number]

export interface FeatureCheck {
  feature: string
  status: 'pass' | 'fail' | 'auth-required' | 'skipped'
  route?: { method: string; path: string; name?: string }
  httpStatus?: number
  /** The component the page payload names, and what the graph says the landmark renders. */
  component?: string
  expected?: string[]
  location?: string
  reason?: string
  events: RuntimeErrorEvent[]
}

export interface ErrorWindow {
  status: 'conclusive' | 'inconclusive' | 'unavailable'
  reason?: string
  events: RuntimeErrorEvent[]
}

export interface DoctorReport {
  result: 'pass' | 'fail' | 'inconclusive'
  origin: string
  map: Pick<BrowserMap, 'complete' | 'gaps'>
  window: ErrorWindow
  features: FeatureCheck[]
  /** Events no mapped route accounts for, each failing the run. */
  uncorrelated: RuntimeErrorEvent[]
  reasons: string[]
}

export interface DoctorIo {
  fetch: (url: string, init: RequestInit) => Promise<Response>
  readErrors: (origin: string, query: RuntimeErrorQuery) => Promise<RuntimeErrorResult>
}

const PAGE_LIMIT = 100

/** The component the Inertia initial page names, from `<script data-page>` or a legacy `data-page` attribute. */
export function pageComponent(html: string): string | undefined {
  // Attributes are tested with `includes`, since chained `[^>]*` groups backtrack polynomially on a large body.
  const openTag = /<script\b[^>]*>/giu
  let tag: RegExpExecArray | null
  while ((tag = openTag.exec(html)) !== null) {
    const text = tag[0].toLowerCase()
    if (!text.includes('data-page="app"') || !text.includes('type="application/json"')) continue
    // Searched on the original, never a lowercased copy: case folding can change a string's length.
    const close = /<\/script\s*>/giu
    close.lastIndex = openTag.lastIndex
    const end = close.exec(html)
    return end ? componentOf(html.slice(openTag.lastIndex, end.index)) : undefined
  }
  const legacy = /data-page="([^"]+)"/u.exec(html)
  if (!legacy) return undefined
  return componentOf(legacy[1]!.replace(/&(quot|amp|lt|gt|#39);/gu, (_, entity: string) => ({ quot: '"', amp: '&', lt: '<', gt: '>', '#39': "'" })[entity]!))
}

function componentOf(json: string): string | undefined {
  try {
    const page = JSON.parse(json) as { component?: unknown }
    return typeof page.component === 'string' ? page.component : undefined
  } catch {
    return undefined
  }
}

type Drained =
  | { status: 'unavailable'; reason: string }
  | { status: 'available'; sessionId: string; head: RuntimeErrorQuery; dropped: number; expired: boolean; events: RuntimeErrorEvent[] }

/** Every event from `from` on, following the cursor to the head, which is the next read's start. */
async function drain(io: DoctorIo, origin: string, from: RuntimeErrorQuery): Promise<Drained> {
  const events: RuntimeErrorEvent[] = []
  let cursor = from
  let expired = false
  for (;;) {
    const page = await io.readErrors(origin, { ...cursor, limit: PAGE_LIMIT })
    if (page.status !== 'available') return { status: 'unavailable', reason: page.reason }
    expired ||= page.cursorExpired
    events.push(...page.events)
    cursor = { sessionId: page.nextCursor.sessionId, after: page.nextCursor.after }
    if (page.events.length < PAGE_LIMIT) return { status: 'available', sessionId: page.sessionId, head: cursor, dropped: page.dropped, expired, events }
  }
}

async function checkLandmark(io: DoctorIo, origin: string, feature: BrowserFeature): Promise<FeatureCheck> {
  const { landmark } = feature
  if (!landmark) return { feature: feature.name, status: 'skipped', reason: 'Every route rendering this feature takes a path parameter.', events: [] }
  const route = { method: landmark.method, path: landmark.path, ...(landmark.name ? { name: landmark.name } : {}) }
  const base = { feature: feature.name, route, expected: landmark.pages, events: [] }
  let response: Response
  try {
    response = await io.fetch(new URL(landmark.path, origin).href, { redirect: 'manual', headers: { Accept: 'text/html' }, signal: AbortSignal.timeout(15_000) })
  } catch (error) {
    return { ...base, status: 'fail', reason: `The request failed: ${error instanceof Error ? error.message : String(error)}` }
  }
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel()
    const location = response.headers.get('location') ?? undefined
    const redirect = { ...base, httpStatus: response.status, ...(location ? { location } : {}) }
    if (landmark.authentication === 'required') return { ...redirect, status: 'auth-required', reason: 'Its middleware requires a signed-in user, so the page was not compared.' }
    return { ...redirect, status: 'fail', reason: `Redirected to ${location ?? 'nowhere'}, though its middleware requires no signed-in user.` }
  }
  if (response.status !== 200) {
    await response.body?.cancel()
    return { ...base, status: 'fail', httpStatus: response.status, reason: `HTTP ${response.status}.` }
  }
  let html: string
  try {
    html = await response.text()
  } catch (error) {
    return { ...base, status: 'fail', httpStatus: 200, reason: `The body could not be read: ${error instanceof Error ? error.message : String(error)}` }
  }
  const component = pageComponent(html)
  if (component === undefined) return { ...base, status: 'fail', httpStatus: 200, reason: 'The response carries no Inertia page payload.' }
  if (!landmark.pages.includes(component)) {
    return { ...base, status: 'fail', httpStatus: 200, component, reason: `Rendered ${component}, where the graph says ${landmark.pages.join(' or ')}.` }
  }
  return { ...base, status: 'pass', httpStatus: 200, component }
}

/** The doctor over a map already built; `io` is the network, so the judgement is testable without a server. */
export async function examine(map: BrowserMap, origin: string, io: DoctorIo): Promise<DoctorReport> {
  const start = await drain(io, origin, {})
  const features: FeatureCheck[] = []
  for (const feature of map.features) features.push(await checkLandmark(io, origin, feature))

  let window: ErrorWindow
  if (start.status !== 'available') {
    window = { status: 'unavailable', reason: start.reason, events: [] }
  } else {
    const end = await drain(io, origin, start.head)
    if (end.status !== 'available') window = { status: 'unavailable', reason: end.reason, events: [] }
    else if (end.sessionId !== start.sessionId) window = { status: 'inconclusive', reason: 'The app restarted during the run, so its earlier errors are gone.', events: end.events }
    else if (end.expired) window = { status: 'inconclusive', reason: 'Errors from the run were evicted before they were read.', events: end.events }
    else if (end.dropped > start.dropped) window = { status: 'inconclusive', reason: `${end.dropped - start.dropped} error(s) were dropped during the run.`, events: end.events }
    else window = { status: 'conclusive', events: end.events }
  }

  const uncorrelated: RuntimeErrorEvent[] = []
  for (const event of window.events) {
    const owner = event.correlation === 'matched' && event.route
      ? map.features.find((feature) => feature.routes.some((route) => route.method === event.route!.method && route.path === event.route!.pattern))
      : undefined
    const check = owner && features.find((entry) => entry.feature === owner.name)
    if (!check) {
      uncorrelated.push(event)
      continue
    }
    check.events.push(event)
    check.status = 'fail'
    check.reason = `${check.events.length} server error(s) on this feature's routes during the run.`
  }

  const failed = features.some((check) => check.status === 'fail') || uncorrelated.length > 0
  const reasons: string[] = []
  if (features.some((check) => check.status === 'fail')) reasons.push('A feature failed.')
  if (uncorrelated.length > 0) reasons.push(`${uncorrelated.length} server error(s) no mapped route accounts for, or that the server could not tie to one route.`)
  const signIn = features.filter((check) => check.status === 'auth-required').length
  if (signIn > 0) reasons.push(`${signIn} landmark(s) need a signed-in user, so their pages were not compared.`)
  if (!map.complete) reasons.push(`The map is incomplete (${map.gaps.map((gap) => gap.section).join(', ')}).`)
  if (window.status !== 'conclusive') reasons.push(`The runtime-error window is ${window.status}: ${window.reason}`)
  if (!features.some((check) => check.status === 'pass')) reasons.push('No landmark was served as the graph says.')
  const result = failed ? 'fail' : reasons.length > 0 ? 'inconclusive' : 'pass'
  return { result, origin, map: { complete: map.complete, gaps: map.gaps }, window, features, uncorrelated, reasons }
}

export async function runBrowserDoctor(options: { cwd: string; url: string }): Promise<DoctorReport> {
  const origin = runtimeOrigin(options.url).origin
  const graph = await loadApplicationGraph({ cwd: options.cwd, introspect: true })
  return examine(buildBrowserMap(graph, []), origin, { fetch: (url, init) => fetch(url, init), readErrors: fetchRuntimeErrors })
}
