// Imports nothing, so the Dev Center page bundles it beside the handler that serves the same paths.

const PLAN_PAGE = /^\/_guren\/plans\/([^/]+)$/
// `endpoint.ts` in @guren/server spells the feedback path for its CSRF rule, and `plan/page/served.ts` the review's.
const REVIEW_PATH = /^\/_guren\/plans\/([^/]+)\/(review|feedback)$/

const EVIDENCE_PATH = /^\/_guren\/plans\/([^/]+)\/evidence$/
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
