// Imports nothing, so the Dev Center page bundles it beside the handler that serves the same paths.

/** The component catalog (RFC 0036 Future Work); `McpServiceProvider` in @guren/server mounts both paths. */
export const UI_CATALOG_PAGE_PATH = '/_guren/ui'
export const UI_CATALOG_JSON_PATH = '/_guren/ui.json'
/** The preview posts its height under this type, so the Dev Center can size the frame to it. */
export const UI_CATALOG_HEIGHT_MESSAGE = 'guren:ui-catalog:height'

/** The MCP Apps preview (RFC 0038 §8) and its sandbox proxy; `McpServiceProvider` mounts both. */
export const MCP_APPS_PAGE_PATH = '/_guren/mcp-apps'
export const MCP_APPS_SANDBOX_PATH = '/_guren/mcp-apps/sandbox'

/**
 * The sandbox proxy's origin for a preview page on `pageOrigin`: the same port on `127.0.0.1`
 * when the page is on `localhost`, and none otherwise. The specification requires the proxy on
 * another origin than the host page, and swapping the hostname is the one second origin the
 * dev server answers on without binding another port.
 */
export function mcpAppsSandboxOrigin(pageOrigin: string): string | undefined {
  let url: URL
  try { url = new URL(pageOrigin) } catch { return undefined }
  if (url.protocol !== 'http:' || url.hostname !== 'localhost') return undefined
  return `http://127.0.0.1${url.port ? `:${url.port}` : ''}`
}

/** The page origin a sandbox proxy on `sandboxOrigin` serves, the inverse of {@link mcpAppsSandboxOrigin}. */
export function mcpAppsPageOrigin(sandboxOrigin: string): string | undefined {
  let url: URL
  try { url = new URL(sandboxOrigin) } catch { return undefined }
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1') return undefined
  return `http://localhost${url.port ? `:${url.port}` : ''}`
}

const PLAN_PAGE = /^\/_guren\/plans\/([^/]+)$/
// `endpoint.ts` in @guren/server spells the feedback path for its CSRF rule, and `plan/page/served.ts` the review's.
const REVIEW_PATH = /^\/_guren\/plans\/([^/]+)\/(review|feedback)$/

const EVIDENCE_PATH = /^\/_guren\/plans\/([^/]+)\/evidence$/
const READINESS_PATH = /^\/_guren\/plans\/([^/]+)\/readiness\/(approve|close|waive)$/
const SCREENSHOT_PATH = /^\/_guren\/browser\/([^/]+)\/screenshots\/([0-9a-f]{64})$/

export interface ReviewRoute {
  slug: string
  resource: 'review' | 'feedback'
}

/** A path on the running dev server, which owns the origin; `McpServiceProvider` mounts it. */
export function planPagePath(slug: string): string {
  return `/_guren/plans/${encodeURIComponent(slug)}`
}

/** The plan page `plan:render` wrote, served for review with its feedback saved (RFC 0030 §8). */
export function planReviewPath(slug: string): string {
  return `${planPagePath(slug)}/review`
}

/** A review page or its feedback endpoint, or `undefined` for any other path. */
export function reviewRoute(pathname: string): ReviewRoute | undefined {
  const match = REVIEW_PATH.exec(pathname)
  if (!match) return undefined
  try { return { slug: decodeURIComponent(match[1]!), resource: match[2] as ReviewRoute['resource'] } } catch { return undefined }
}

/** Each step's evidence for the plan page: routes, plan:verify records and browser runs. */
export function planEvidencePath(slug: string): string {
  return `${planPagePath(slug)}/evidence`
}

/** The slug an evidence path names, or `undefined` for any other path. */
export function planEvidenceSlug(pathname: string): string | undefined {
  const match = EVIDENCE_PATH.exec(pathname)
  if (!match) return undefined
  try { return decodeURIComponent(match[1]!) } catch { return undefined }
}

/** The person's three decisions on a plan (RFC 0030 §8), each checked by a dry run and copied, never run. */
export type PlanDecision = 'approve' | 'close' | 'waive'

/** Whether a decision's command would go through now; `waive` names one element. */
export function planReadinessPath(slug: string, decision: PlanDecision, element?: string): string {
  const query = element === undefined ? '' : `?element=${encodeURIComponent(element)}`
  return `${planPagePath(slug)}/readiness/${decision}${query}`
}

export function planReadinessRoute(pathname: string): { slug: string; decision: PlanDecision } | undefined {
  const match = READINESS_PATH.exec(pathname)
  if (!match) return undefined
  try { return { slug: decodeURIComponent(match[1]!), decision: match[2] as PlanDecision } } catch { return undefined }
}

/** A `browser:record` screenshot, named by its run and the digest `run.json` records for it. */
export function browserScreenshotPath(run: string, sha256: string): string {
  return `/_guren/browser/${encodeURIComponent(run)}/screenshots/${sha256}`
}

export function browserScreenshotRoute(pathname: string): { run: string; sha256: string } | undefined {
  const match = SCREENSHOT_PATH.exec(pathname)
  if (!match) return undefined
  try { return { run: decodeURIComponent(match[1]!), sha256: match[2]! } } catch { return undefined }
}

/** What the person sends the agent once the review is saved: the file, never the review itself. */
export function savedReviewPrompt(plan: string, reviewFile: string): string {
  return `Revise ${plan} from my review with the plan-write skill. The review is saved in ${reviewFile}.`
}

/** The slug a plan page is served under, or `undefined` off a plan page. */
export function planSlugFromPath(pathname: string): string | undefined {
  const match = PLAN_PAGE.exec(pathname)
  if (!match) return undefined
  try { return decodeURIComponent(match[1]!) } catch { return undefined }
}

/** One line for a plan command's text output, naming where the person reads the plan's state. */
export function devCenterPlanLine(path: string): string {
  return `Dev Center: ${path} on the running dev server shows the person every step of this plan.`
}
