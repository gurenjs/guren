import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { applyBoardOpsFile, boardPath, createBoard } from '../src/board/store'
import type { BoardStatusReport } from '../src/board/status'
import { createDevCenterHandler } from '../src/dev-center'
import type { BoardStatusReading } from '../src/dev-center-board'
import { linkCounts, linkStateOf, noteLinkStates } from '../src/dev-center-page/board-links'
import { describeBoard, readBoardLinks, readBoards } from '../src/dev-center-page/boards'
import { boardJsonPath, boardOpsPath, boardPagePath, boardRoute, boardSlugFromPath, boardStatusPath } from '../src/dev-center-links'
import { runReadinessChild, type ReadinessRunner } from '../src/dev-center-readiness'
import { createTempRoot } from './helpers'

const ORIGIN = 'http://localhost:3000'
const OPS = [
  { op: 'add', id: 'aa', kind: 'event', text: 'A' },
  { op: 'add', id: 'bb', kind: 'reaction', text: 'B', after: 'aa' },
  { op: 'connect', from: 'aa', to: 'bb' },
]

let root: string
let count = 0

async function app(): Promise<string> {
  count += 1
  const dir = join(root, `app-${count}`)
  await createBoard(dir, { slug: 'demo', title: 'Demo', locale: 'en' })
  return dir
}

const handler = (cwd: string) => createDevCenterHandler({ cwd, graph: async () => { throw new Error('not read') } })
const get = (cwd: string, path: string) => handler(cwd).fetch(new Request(`${ORIGIN}${path}`))
const post = (cwd: string, body: unknown, headers: Record<string, string> = { origin: ORIGIN, 'content-type': 'application/json' }, path = boardOpsPath('demo')) =>
  handler(cwd).fetch(new Request(`${ORIGIN}${path}`, { method: 'POST', headers, body: typeof body === 'string' ? body : JSON.stringify(body) }))

beforeAll(async () => {
  root = await createTempRoot('guren-dev-center-board-')
})

afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('board paths', () => {
  test('should name a board page, its document and its operations endpoint', () => {
    expect(boardPagePath('demo')).toBe('/_guren/boards/demo')
    expect(boardSlugFromPath('/_guren/boards/demo')).toBe('demo')
    expect(boardSlugFromPath('/_guren/boards/demo/extra')).toBeUndefined()
    expect(boardSlugFromPath('/_guren/boards/')).toBeUndefined()
    expect(boardRoute(boardJsonPath('demo'))).toEqual({ slug: 'demo', resource: 'board' })
    expect(boardRoute(boardOpsPath('demo'))).toEqual({ slug: 'demo', resource: 'ops' })
    expect(boardRoute(boardStatusPath('demo'))).toEqual({ slug: 'demo', resource: 'status' })
    expect(boardRoute('/_guren/boards/demo/other')).toBeUndefined()
    expect(boardRoute('/_guren/boards/%E0%A4%A/ops')).toBeUndefined()
  })
})

describe('board documents', () => {
  test('should return the board with its outline, never cached', async () => {
    const dir = await app()
    await applyBoardOpsFile(dir, 'demo', OPS as never)

    const response = await get(dir, boardJsonPath('demo'))
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(body).toMatchObject({ schemaVersion: 1, slug: 'demo', file: 'docs/boards/demo.board.json', board: { title: 'Demo' } })
    expect(body.outline).toContain('  [event aa] A  -> bb')
  })

  test('should answer 404 for a board that does not exist and for a slug that is not one', async () => {
    const dir = await app()

    for (const path of [boardJsonPath('nothing'), '/_guren/boards/..%2F..%2Fpackage/board.json', '/_guren/boards/Bad%20Slug/board.json']) {
      const response = await get(dir, path)
      expect(response.status, path).toBe(404)
      expect(await response.json(), path).toMatchObject({ error: { code: 'no-board' } })
    }
  })

  test('should answer 503 with the reason for a file that is not a board', async () => {
    const dir = await app()
    await writeFile(boardPath(dir, 'demo'), '{ not json')

    const response = await get(dir, boardJsonPath('demo'))

    expect(response.status).toBe(503)
    expect(await response.json()).toMatchObject({ error: { code: 'unreadable' } })
  })

  test('should list the boards, and answer 503 without the exception text when the read fails', async () => {
    const dir = await app()

    const listed = await (await get(dir, '/_guren/boards.json')).json()
    const failing = createDevCenterHandler({ cwd: dir, boards: async () => { throw new Error('secret') } })
    const failed = await failing.fetch(new Request(`${ORIGIN}/_guren/boards.json`))

    expect(listed).toMatchObject({ schemaVersion: 1, boards: [{ slug: 'demo', title: 'Demo', notes: 0 }] })
    expect(failed.status).toBe(503)
    expect(await failed.text()).not.toContain('secret')
  })

  test('should serve the shell for the list and for one board, and nothing deeper', async () => {
    const dir = await app()

    for (const path of ['/_guren/boards', '/_guren/boards/demo']) {
      const page = await get(dir, path)
      expect(page.status, path).toBe(200)
      expect(await page.text(), path).toContain('id="board-view"')
    }
    expect((await get(dir, '/_guren/boards/demo/extra')).status).toBe(404)
    expect((await get(dir, '/_guren/boards/demo/status/extra')).status).toBe(404)
  })
})

describe('board operations', () => {
  test('should apply the operations and return the board as written', async () => {
    const dir = await app()

    const response = await post(dir, OPS)
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body).toMatchObject({ schemaVersion: 1, slug: 'demo', changed: true, applied: 3, dropped: [] })
    expect(body.board.arrows).toEqual([{ from: 'aa', to: 'bb' }])
    expect(JSON.parse(await readFile(boardPath(dir, 'demo'), 'utf8')).notes.map((note: { id: string }) => note.id)).toEqual(['aa', 'bb'])
  })

  test('should report a dropped operation and still apply the rest', async () => {
    const dir = await app()

    const body = await (await post(dir, { ops: [...OPS, { op: 'connect', from: 'aa', to: 'nobody' }] })).json()

    expect(body).toMatchObject({ applied: 3, dropped: [{ index: 3, op: 'connect', reason: 'no note is named nobody' }] })
  })

  test('should refuse another origin, another type, a body that is not JSON and a list off its schema, writing nothing', async () => {
    const dir = await app()
    const before = await readFile(boardPath(dir, 'demo'), 'utf8')

    expect((await post(dir, OPS, { origin: 'http://evil.test', 'content-type': 'application/json' })).status).toBe(403)
    expect((await post(dir, OPS, { 'content-type': 'application/json' })).status).toBe(403)
    expect((await post(dir, OPS, { origin: ORIGIN, 'content-type': 'text/plain' })).status).toBe(415)
    expect((await post(dir, '{ not json')).status).toBe(400)
    const offSchema = await post(dir, [{ op: 'add', id: 'Bad Id', kind: 'event', text: 'x' }])
    expect(offSchema.status).toBe(400)
    expect(await offSchema.json()).toMatchObject({ error: { code: 'schema' } })

    expect(await readFile(boardPath(dir, 'demo'), 'utf8')).toBe(before)
  })

  test('should answer 404 for a missing board or a slug that is not one, leaving no lock directory', async () => {
    const dir = join(root, 'no-boards')

    expect((await post(dir, OPS, undefined, boardOpsPath('nothing'))).status).toBe(404)
    expect((await post(dir, OPS, undefined, '/_guren/boards/..%2F..%2Fpackage/ops')).status).toBe(404)
    expect(existsSync(join(dir, '.guren'))).toBe(false)
  })

  test('should answer 405 for a read of the operations endpoint and a write to the document', async () => {
    const dir = await app()

    const read = await get(dir, boardOpsPath('demo'))
    const write = await post(dir, OPS, undefined, boardJsonPath('demo'))

    expect([read.status, read.headers.get('allow')]).toEqual([405, 'POST'])
    expect([write.status, write.headers.get('allow')]).toEqual([405, 'GET'])
  })
})

describe('the boards list on the page', () => {
  test('should read a 404 as a dev server that predates the routes, not as a failure', async () => {
    const overview = { schemaVersion: 1, boards: [{ slug: 'demo', file: 'docs/boards/demo.board.json' }] }

    expect(await readBoards(async () => new Response('Not found', { status: 404 }))).toEqual({ unmounted: true })
    expect(await readBoards(async () => Response.json(overview))).toEqual({ boards: overview.boards })
    await expect(readBoards(async () => new Response('down', { status: 503 }))).rejects.toThrow('HTTP 503')
    await expect(readBoards(async () => Response.json({ schemaVersion: 2, boards: [] }))).rejects.toThrow('Unsupported boards payload')
  })

  test('should describe a board by its counts, or by why it is not one', () => {
    const file = 'docs/boards/demo.board.json'

    expect(describeBoard({ slug: 'demo', file, notes: 3, questions: 1, arrows: 0, sections: 2 })).toBe('3 notes · 1 question · 0 arrows · 2 sections')
    expect(describeBoard({ slug: 'demo', file, unreadable: `${file} is not valid JSON` })).toBe(`${file} is not valid JSON`)
  })
})

const REPORT: BoardStatusReport = {
  reportVersion: 1,
  board: { slug: 'demo', file: 'docs/boards/demo.board.json', title: 'Demo' },
  plans: [{ file: 'docs/plans/demo/plan.json', source: 'open' }],
  unreadPlans: [],
  notes: [
    { id: 'aa', kind: 'aggregate', text: 'Post', link: { kind: 'model', name: 'Post' }, state: 'present' },
    { id: 'bb', kind: 'event', text: 'Published', link: { kind: 'event', name: 'PostPublished' }, state: 'planned', plannedIn: ['docs/plans/demo/plan.json'] },
    { id: 'cc', kind: 'command', text: 'Publish', link: { kind: 'route', name: 'posts.publish' }, state: 'missing' },
    { id: 'dd', kind: 'reaction', text: 'Tell', state: 'unlinked' },
  ],
  leadsNowhere: ['cc', 'dd'],
}

type Call = { argv: string[]; cwd: string; env: NodeJS.ProcessEnv }

const answering = (child: Awaited<ReturnType<ReadinessRunner>>, calls: Call[] = []): ReadinessRunner =>
  async (argv, cwd, env) => {
    calls.push({ argv, cwd, env })
    return child
  }

async function linkStatus(cwd: string, run: ReadinessRunner, path = boardStatusPath('demo'), method = 'GET'): Promise<{ status: number; body: BoardStatusReading & { error?: { code: string } } }> {
  const response = await createDevCenterHandler({ cwd, graph: async () => { throw new Error('not read') }, boardStatus: run }).fetch(new Request(`${ORIGIN}${path}`, { method }))
  expect(response.headers.get('cache-control')).toBe('no-store')
  return { status: response.status, body: await response.json().catch(() => ({})) as BoardStatusReading & { error?: { code: string } } }
}

describe('board link status', () => {
  test('should run board:status for the board in the app root and answer its report', async () => {
    const dir = await app()
    const calls: Call[] = []
    const { status, body } = await linkStatus(dir, answering({ exitCode: 0, stdout: `an app module printed this\n${JSON.stringify(REPORT, null, 2)}\n`, stderr: '' }, calls))

    expect(status).toBe(200)
    expect(body).toMatchObject({ schemaVersion: 1, status: 'ready', report: REPORT })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.argv).toEqual(['board:status', 'demo', '--json', '--app', dir])
    expect(calls[0]!.cwd).toBe(dir)
    expect(calls[0]!.env.NO_COLOR).toBe('1')
  })

  test('should answer unavailable, never ready, for a child that fails, refuses, crashes or prints no report', async () => {
    const dir = await app()
    const cases: Array<[Awaited<ReturnType<ReadinessRunner>>, string]> = [
      [{ exitCode: null, stdout: '', stderr: '', failed: 'The check took too long or was stopped.' }, 'The check took too long or was stopped.'],
      [{ exitCode: 1, stdout: '', stderr: ' ERROR  --plan needs a plan file.\n' }, '--plan needs a plan file.'],
      [{ exitCode: 1, stdout: '', stderr: 'TypeError: boom\n    at run (bin.js:1:1)\n' }, 'board:status crashed: TypeError: boom'],
      [{ exitCode: 1, stdout: '', stderr: '' }, 'board:status exited with 1 and said nothing.'],
      [{ exitCode: 0, stdout: '{"reportVersion": 2}\n', stderr: '' }, 'board:status did not print a report this page reads.'],
      [{ exitCode: 0, stdout: 'not json', stderr: '' }, 'board:status did not print a report this page reads.'],
    ]
    for (const [child, message] of cases) {
      const { status, body } = await linkStatus(dir, answering(child))
      expect(status, message).toBe(200)
      expect(body.status, message).toBe('unavailable')
      expect(body.report, message).toBeUndefined()
      expect(body.message, message).toStartWith(message)
    }
  })

  test('should answer 404 for a missing board or a slug that is not one, starting no child, and 405 for a write', async () => {
    const dir = await app()
    const calls: Call[] = []
    const run = answering({ exitCode: 0, stdout: JSON.stringify(REPORT), stderr: '' }, calls)

    for (const path of [boardStatusPath('nothing'), '/_guren/boards/--help/status', '/_guren/boards/Bad%20Slug/status']) {
      const { status, body } = await linkStatus(dir, run, path)
      expect(status, path).toBe(404)
      expect(body.error?.code, path).toBe('no-board')
    }
    expect((await linkStatus(dir, run, boardStatusPath('demo'), 'POST')).status).toBe(405)
    expect(calls).toHaveLength(0)
  })

  test('should read a real board:status run in an app with nothing to judge', async () => {
    const dir = await app()
    await writeFile(join(dir, 'bunfig.toml'), '[install]\nauto = "disable"\n')
    await applyBoardOpsFile(dir, 'demo', [{ op: 'add', id: 'aa', kind: 'aggregate', text: 'Post' }, { op: 'link', id: 'aa', link: { kind: 'model', name: 'Post' } }] as never)

    const { body } = await linkStatus(dir, runReadinessChild)

    expect(body.status).toBe('ready')
    expect(body.report?.board.slug).toBe('demo')
    expect(body.report?.notes.map((note) => note.id)).toEqual(['aa'])
  }, 60_000)
})

describe('the link overlay on the page', () => {
  test('should read the route\'s answers, and a 404 that is no board\'s as a CLI that predates the route', async () => {
    const ready: BoardStatusReading = { schemaVersion: 1, status: 'ready', checkedAt: '2026-11-28T00:00:00.000Z', report: REPORT }

    expect(await readBoardLinks('demo', async () => Response.json(ready))).toEqual({ kind: 'ready', report: REPORT })
    expect(await readBoardLinks('demo', async () => Response.json({ ...ready, status: 'unavailable', report: undefined, message: 'boom' }))).toEqual({ kind: 'unavailable', message: 'boom' })
    expect(await readBoardLinks('demo', async () => Response.json({ error: { code: 'no-board', message: 'No board' } }, { status: 404 }))).toEqual({ kind: 'unavailable', message: 'No board' })
    expect((await readBoardLinks('demo', async () => new Response('Not found', { status: 404 }))).kind).toBe('unavailable')
    expect(await readBoardLinks('demo', async () => new Response('Not found', { status: 404 }))).toMatchObject({ message: expect.stringContaining('predates the status route') })
    expect(await readBoardLinks('demo', async () => { throw new Error('offline') })).toEqual({ kind: 'unavailable', message: 'offline' })
  })

  test('should draw a state only on a note still carrying the link the report judged', () => {
    const states = noteLinkStates(REPORT)
    const note = (id: string, link?: { kind: 'model' | 'event' | 'route'; name: string; module?: string }) => ({ id, kind: 'event' as const, text: 'x', x: 0, y: 0, ...(link ? { link } : {}) })

    expect([...states.keys()]).toEqual(['aa', 'bb', 'cc'])
    expect(linkStateOf(note('aa', { kind: 'model', name: 'Post' }), states)).toMatchObject({ state: 'present' })
    expect(linkStateOf(note('bb', { kind: 'event', name: 'PostPublished' }), states)).toMatchObject({ state: 'planned', plannedIn: ['docs/plans/demo/plan.json'] })
    expect(linkStateOf(note('aa', { kind: 'model', name: 'Comment' }), states)).toBeUndefined()
    expect(linkStateOf(note('aa', { kind: 'model', name: 'Post', module: 'billing' }), states)).toBeUndefined()
    expect(linkStateOf(note('aa'), states)).toBeUndefined()
    expect(linkStateOf(note('zz', { kind: 'model', name: 'Post' }), states)).toBeUndefined()
  })

  test('should count each state and the notes that lead nowhere', () => {
    expect(linkCounts(REPORT)).toEqual({ present: 1, planned: 1, missing: 1, unknown: 0, leadNowhere: 2 })
  })
})
