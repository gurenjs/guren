/**
 * The Dev Center's board routes (RFC 0041 §2): a board's document with its outline, and the
 * endpoint the canvas posts operations to. That POST is the Dev Center's second write and the
 * first to a tracked file. It carries no decision: nothing reads a board as approval, and
 * what it can write an agent can already write to the file.
 */

import { BoardOpsDocumentSchema, boardOpsOf } from './board/ops'
import { isBoardSlug, boardFile } from './board/schema'
import { applyBoardOpsFile, BoardError, listBoards, readBoard, type BoardOverview } from './board/store'
import { renderBoardOutline } from './board/text'
import { CliError, formatSchemaIssues } from './cli-error'
import type { BoardRoute } from './dev-center-links'
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
export async function handleBoardRequest(cwd: string, request: Request, route: BoardRoute): Promise<Response> {
  const allowed = route.resource === 'ops' ? 'POST' : 'GET'
  if (request.method !== allowed) return new Response('Method not allowed', { status: 405, headers: { ...NO_STORE, Allow: allowed } })
  // Before any path is built from it: the slug arrives percent-decoded from the URL.
  if (!isBoardSlug(route.slug)) return problem(404, 'no-board', 'No board has this name.')
  try {
    return route.resource === 'ops' ? await applyOps(cwd, route.slug, request) : await serveBoard(cwd, route.slug)
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
