/**
 * The Dev Center's board routes (RFC 0041 §2, §3): a board's document with its outline, what
 * `board:status` reports for it, and the endpoint the canvas posts operations to. That POST is the
 * Dev Center's second write and the first to a tracked file. It carries no decision: nothing reads
 * a board as approval, and what it can write an agent can already write to the file.
 */

import { BoardOpsDocumentSchema, boardOpsOf } from './board/ops'
import { isBoardSlug, boardFile } from './board/schema'
import { applyBoardOpsFile, BoardError, listBoards, readBoard, type BoardOverview } from './board/store'
import { renderBoardOutline } from './board/text'
import { CliError, formatSchemaIssues } from './cli-error'
import type { BoardStatusReport } from './board/status'
import type { BoardRoute } from './dev-center-links'
import { lastReport, refusalText, runReadinessChild, STACK_FRAME, type ReadinessRunner } from './dev-center-readiness'
import { NO_STORE, problem } from './dev-center-review'
import { readWithinLimit } from './plan/feedback'

const STATUS: Record<BoardError['code'], number> = { missing: 404, unreadable: 503, locked: 409, invalid: 409 }

function answerFailure(error: unknown): Response {
  if (error instanceof BoardError) return problem(STATUS[error.code], error.code === 'missing' ? 'no-board' : error.code, error.message)
  throw error
}

async function serveBoard(cwd: string, slug: string): Promise<Response> {
  const board = await readBoard(cwd, slug)
  return Response.json({ schemaVersion: 1, slug, file: boardFile(slug), board, outline: renderBoardOutline(board, slug) }, { headers: NO_STORE })
}

export interface BoardStatusReading {
  schemaVersion: 1
  status: 'ready' | 'unavailable'
  checkedAt: string
  /** `ready`: what `guren board:status --json` printed. */
  report?: BoardStatusReport
  /** `unavailable`: why no report came. */
  message?: string
}

function isStatusReport(value: unknown): value is BoardStatusReport {
  const report = value as Partial<BoardStatusReport> | undefined
  return report?.reportVersion === 1 && Array.isArray(report.notes) && Array.isArray(report.leadsNowhere)
}

/**
 * `board:status` runs as a child, as the readiness checks do: it imports `db/schema.ts` and the
 * validator files, which the dev server's own module cache would keep past the next edit.
 */
export async function readBoardStatus(appRoot: string, slug: string, run: ReadinessRunner = runReadinessChild, now: () => Date = () => new Date()): Promise<BoardStatusReading> {
  // In process first, so a board that is gone answers 404 rather than a child's refusal.
  await readBoard(appRoot, slug)
  const head = { schemaVersion: 1 as const, checkedAt: now().toISOString() }
  const child = await run(['board:status', slug, '--json', '--app', appRoot], appRoot, { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' })
  if (child.failed) return { ...head, status: 'unavailable', message: child.failed }
  if (child.exitCode === 0) {
    try {
      const report = lastReport(child.stdout)
      if (isStatusReport(report)) return { ...head, status: 'ready', report }
    } catch {
      // Falls through: output that is not the report is never drawn.
    }
    return { ...head, status: 'unavailable', message: 'board:status did not print a report this page reads. Upgrade both @guren packages together.' }
  }
  const said = refusalText(child.stderr)
  if (!said) return { ...head, status: 'unavailable', message: `board:status exited with ${child.exitCode} and said nothing.` }
  return { ...head, status: 'unavailable', message: STACK_FRAME.test(child.stderr) ? `board:status crashed: ${said}` : said }
}

async function applyOps(cwd: string, slug: string, request: Request): Promise<Response> {
  // Apps without auth have no CSRF middleware, so this is what stops another site posting here.
  if (request.headers.get('origin') !== new URL(request.url).origin) return problem(403, 'origin', 'Board edits are accepted from the Dev Center page only.')
  if (!/^application\/json\b/i.test(request.headers.get('content-type') ?? '')) return problem(415, 'content-type', 'Send the operations as application/json.')
  let text: string
  try {
    text = request.body ? await readWithinLimit(request.body, 'operations', 'the request') : ''
  } catch (error) {
    if (error instanceof CliError) return problem(413, 'too-large', 'The operations are larger than a list of them can be.')
    throw error
  }
  let body: unknown
  try { body = JSON.parse(text) } catch { return problem(400, 'json', 'The operations are not JSON.') }
  const parsed = BoardOpsDocumentSchema.safeParse(body)
  if (!parsed.success) return problem(400, 'schema', `The operations do not match their schema:\n${formatSchemaIssues(parsed.error)}`)

  let result: Awaited<ReturnType<typeof applyBoardOpsFile>>
  try {
    result = await applyBoardOpsFile(cwd, slug, boardOpsOf(parsed.data))
  } catch (error) {
    if (error instanceof BoardError) return answerFailure(error)
    return problem(503, 'write-failed', `The board could not be written (${(error as NodeJS.ErrnoException).code ?? 'write error'}).`)
  }
  const { file, changed, applied, dropped, board } = result
  // The whole board comes back, so the page shows what is on disk, another writer's edits included.
  return Response.json({ schemaVersion: 1, slug, file, changed, applied, dropped, board, outline: renderBoardOutline(board, slug) }, { headers: NO_STORE })
}

/** A request on the path `boardRoute()` read as `route`. */
export async function handleBoardRequest(cwd: string, request: Request, route: BoardRoute, run?: ReadinessRunner): Promise<Response> {
  const allowed = route.resource === 'ops' ? 'POST' : 'GET'
  if (request.method !== allowed) return new Response('Method not allowed', { status: 405, headers: { ...NO_STORE, Allow: allowed } })
  // Before any path is built from it: the slug arrives percent-decoded from the URL.
  if (!isBoardSlug(route.slug)) return problem(404, 'no-board', 'No board has this name.')
  try {
    if (route.resource === 'ops') return await applyOps(cwd, route.slug, request)
    if (route.resource === 'status') return Response.json(await readBoardStatus(cwd, route.slug, run), { headers: NO_STORE })
    return await serveBoard(cwd, route.slug)
  } catch (error) {
    if (error instanceof BoardError) return answerFailure(error)
    return problem(503, 'read-failed', 'The board could not be read.')
  }
}

export async function handleBoardListRequest(cwd: string, load: (cwd: string) => Promise<BoardOverview> = listBoards): Promise<Response> {
  try {
    return Response.json(await load(cwd), { headers: NO_STORE })
  } catch {
    return problem(503, 'read-failed', 'The boards could not be read.')
  }
}
