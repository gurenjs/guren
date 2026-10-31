// Imports nothing, so the Dev Center page bundles it beside the handler that serves the same paths.

const PLAN_PAGE = /^\/_guren\/plans\/([^/]+)$/

/** A path on the running dev server, which owns the origin; `McpServiceProvider` mounts it. */
export function planPagePath(slug: string): string {
  return `/_guren/plans/${encodeURIComponent(slug)}`
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
