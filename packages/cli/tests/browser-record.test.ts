import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'

import { BROWSER_RUNS_DIR, beginRun, closeStep, lowerResult, openStep, writeDoctorEvidence, type RecordDeps } from '../src/browser-record'
import { recoverStdinDash } from '../src/plan/feedback'
import type { RuntimeErrorEvent } from '../src/runtime-error-window'
import type { RuntimeErrorQuery } from '../src/runtime-errors'

let cwd: string
beforeEach(async () => { cwd = await mkdtemp(join(tmpdir(), 'guren-browser-record-')) })
afterEach(async () => { await rm(cwd, { recursive: true, force: true }) })

function event(sequence: number): RuntimeErrorEvent {
  return { sessionId: 's1', sequence, occurredAt: '2026-10-16T00:00:00.000Z', method: 'GET', route: { method: 'GET', pattern: '/' }, correlation: 'matched', status: 500, category: 'server-error', frames: [] }
}

function deps(events: RuntimeErrorEvent[], options: { unavailable?: boolean } = {}): RecordDeps {
  return {
    async readErrors(_origin, query: RuntimeErrorQuery) {
      if (options.unavailable) return { schemaVersion: 1, status: 'unavailable', reason: 'offline' }
      const page = events.filter((entry) => entry.sequence > (query.after ?? 0)).slice(0, query.limit ?? 20)
      return {
        schemaVersion: 1, status: 'available', sessionId: 's1', startedAt: '2026-10-16T00:00:00.000Z', events: page,
        nextCursor: { sessionId: 's1', after: page.at(-1)?.sequence ?? events.at(-1)?.sequence ?? 0 }, dropped: 0, cursorExpired: false,
      }
    },
    graphSnapshot: async () => 'snapshot-1',
    commit: async () => ({ rev: 'abc123', dirty: false }),
    now: () => new Date('2026-10-16T10:42:07.123Z'),
  }
}

const passing = { result: 'pass', action: 'open /posts', landed: { url: '/posts', component: 'posts/Index' } }

describe('lowerResult', () => {
  test('only ever lowers the recorder\'s result', () => {
    expect(lowerResult('pass', { status: 'conclusive', events: [] })).toEqual({ result: 'pass' })
    expect(lowerResult('pass', { status: 'conclusive', events: [{}] })).toEqual({ result: 'fail', lowered: '1 server error(s) during the step.' })
    expect(lowerResult('pass', { status: 'unavailable', events: [] })).toEqual({ result: 'inconclusive', lowered: 'The runtime-error window is unavailable.' })
    expect(lowerResult('fail', { status: 'unavailable', events: [] })).toEqual({ result: 'fail' })
  })
})

describe('a recorded run', () => {
  test('begins under a timestamp and the feature, ignored by git', async () => {
    const run = await beginRun(cwd, { url: 'http://127.0.0.1:4317', feature: 'Posts' }, deps([]))
    expect(run.run).toBe('2026-10-16T10-42-07Z-posts')
    expect(run).toMatchObject({ origin: 'http://127.0.0.1:4317', graphSnapshot: 'snapshot-1', commit: { rev: 'abc123', dirty: false }, steps: [] })
    expect(await readFile(join(cwd, BROWSER_RUNS_DIR, '.gitignore'), 'utf8')).toBe('*\n')
    expect((await beginRun(cwd, { url: 'http://127.0.0.1:4317', feature: 'Posts' }, deps([]))).run).toBe('2026-10-16T10-42-07Z-posts-2')
  })

  test('refuses an origin that is not loopback', async () => {
    await expect(beginRun(cwd, { url: 'http://db.example.com', feature: 'Posts' }, deps([]))).rejects.toThrow('loopback')
  })

  test('keeps the recorder\'s account apart from what it measured, and lowers a pass on a server error', async () => {
    const events = [event(1)]
    const { run } = await beginRun(cwd, { url: 'http://127.0.0.1:4317', feature: 'Posts' }, deps(events))
    await openStep(cwd, run, 'AC-posts-1', deps(events))
    events.push(event(2))
    await writeFile(join(cwd, BROWSER_RUNS_DIR, run, 'screenshots', 'after.png'), 'png')
    const step = await closeStep(cwd, run, 'AC-posts-1', { ...passing, screenshots: ['screenshots/after.png'] }, deps(events))

    expect(step).toMatchObject({ id: 'AC-posts-1', result: 'fail', lowered: '1 server error(s) during the step.', recorder: passing })
    expect(step.cli.screenshots).toEqual([{ path: 'screenshots/after.png', sha256: expect.stringMatching(/^[0-9a-f]{64}$/u) }])
    expect(step.cli.runtimeErrors).toEqual({ window: 'conclusive', events: 1 })
    const written = JSON.parse(await readFile(join(cwd, BROWSER_RUNS_DIR, run, 'runtime-errors.json'), 'utf8')) as RuntimeErrorEvent[]
    expect(written.map((entry) => entry.sequence)).toEqual([2])
    const stored = JSON.parse(await readFile(join(cwd, BROWSER_RUNS_DIR, run, 'run.json'), 'utf8')) as { steps: unknown[]; open: object }
    expect(stored.steps).toHaveLength(1)
    expect(stored.open).toEqual({})
  })

  test('makes a pass inconclusive when the collector could not be read', async () => {
    const { run } = await beginRun(cwd, { url: 'http://127.0.0.1:4317', feature: 'Posts' }, deps([]))
    await openStep(cwd, run, 'AC-posts-1', deps([], { unavailable: true }))
    const step = await closeStep(cwd, run, 'AC-posts-1', passing, deps([]))
    expect(step).toMatchObject({ result: 'inconclusive', cli: { runtimeErrors: { window: 'unavailable', events: 0 } } })
  })

  test('refuses an unopened step, a screenshot outside the run, an unknown field and a step recorded twice', async () => {
    const { run } = await beginRun(cwd, { url: 'http://127.0.0.1:4317', feature: 'Posts' }, deps([]))
    await expect(closeStep(cwd, run, 'missing', passing, deps([]))).rejects.toThrow('was never opened')
    await openStep(cwd, run, 'AC-posts-1', deps([]))
    await expect(closeStep(cwd, run, 'AC-posts-1', { ...passing, screenshots: ['../run.json'] }, deps([]))).rejects.toThrow('is outside')
    await expect(closeStep(cwd, run, 'AC-posts-1', { ...passing, verdict: 'trust me' }, deps([]))).rejects.toThrow('verdict')
    await closeStep(cwd, run, 'AC-posts-1', passing, deps([]))
    await expect(openStep(cwd, run, 'AC-posts-1', deps([]))).rejects.toThrow('already recorded')
  })

  test('refuses a run name that could leave the runs directory', async () => {
    await expect(openStep(cwd, '../escape', 'step', deps([]))).rejects.toThrow('is not a run name')
    await expect(openStep(cwd, '..', 'step', deps([]))).rejects.toThrow('is not a run name')
  })

  test('refuses step ids an object already holds, so none passes the never-opened check', async () => {
    const { run } = await beginRun(cwd, { url: 'http://127.0.0.1:4317', feature: 'Posts' }, deps([]))
    for (const id of ['constructor', 'toString', '__proto__', '../x']) {
      await expect(closeStep(cwd, run, id, passing, deps([]))).rejects.toThrow('is not a step id')
    }
  })

  test('resolves a relative app root, and refuses a screenshot that links outside the run', async () => {
    const { run } = await beginRun(cwd, { url: 'http://127.0.0.1:4317', feature: 'Posts' }, deps([]))
    const relativeRoot = relative(process.cwd(), cwd)
    const shots = join(cwd, BROWSER_RUNS_DIR, run, 'screenshots')
    await writeFile(join(shots, 'ok.png'), 'png')
    await writeFile(join(cwd, 'secret.txt'), 'secret')
    await symlink(join(cwd, 'secret.txt'), join(shots, 'link.png'))
    await openStep(relativeRoot, run, 'AC-posts-1', deps([]))
    await expect(closeStep(relativeRoot, run, 'AC-posts-1', { ...passing, screenshots: ['screenshots/link.png'] }, deps([]))).rejects.toThrow('is not a file inside')
    const step = await closeStep(relativeRoot, run, 'AC-posts-1', { ...passing, screenshots: ['screenshots/ok.png'] }, deps([]))
    expect(step.cli.screenshots.map((shot) => shot.path)).toEqual(['screenshots/ok.png'])
  })

  test('refuses a corrupt run.json rather than throwing a parse error or replacing it', async () => {
    const { run } = await beginRun(cwd, { url: 'http://127.0.0.1:4317', feature: 'Posts' }, deps([]))
    await writeFile(join(cwd, BROWSER_RUNS_DIR, run, 'run.json'), '{ not json')
    await expect(openStep(cwd, run, 'AC-posts-1', deps([]))).rejects.toThrow('is not valid JSON')
  })

  test('keeps a .gitignore someone already wrote', async () => {
    await mkdir(join(cwd, BROWSER_RUNS_DIR), { recursive: true })
    await writeFile(join(cwd, BROWSER_RUNS_DIR, '.gitignore'), '*\n!keep.md\n')
    await beginRun(cwd, { url: 'http://127.0.0.1:4317', feature: 'Posts' }, deps([]))
    expect(await readFile(join(cwd, BROWSER_RUNS_DIR, '.gitignore'), 'utf8')).toBe('*\n!keep.md\n')
  })

  test('appends each server error once, however often it is drained', async () => {
    const events = [event(1)]
    const { run } = await beginRun(cwd, { url: 'http://127.0.0.1:4317', feature: 'Posts' }, deps(events))
    await openStep(cwd, run, 'a', deps(events))
    events.push(event(2))
    await closeStep(cwd, run, 'a', passing, deps(events))
    await openStep(cwd, run, 'b', deps(events))
    events.push(event(3))
    // As if an earlier close had appended event 3 and then failed to write run.json.
    await writeFile(join(cwd, BROWSER_RUNS_DIR, run, 'runtime-errors.json'), JSON.stringify([event(2), event(3)]))
    await closeStep(cwd, run, 'b', passing, deps(events))
    const written = JSON.parse(await readFile(join(cwd, BROWSER_RUNS_DIR, run, 'runtime-errors.json'), 'utf8')) as RuntimeErrorEvent[]
    expect(written.map((entry) => entry.sequence)).toEqual([2, 3])
  })

  test('files a doctor report only into a run against the same origin', async () => {
    const { run } = await beginRun(cwd, { url: 'http://127.0.0.1:4317', feature: 'Posts' }, deps([]))
    await expect(writeDoctorEvidence(cwd, run, { origin: 'http://127.0.0.1:9999' })).rejects.toThrow('not http://127.0.0.1:9999')
    await writeDoctorEvidence(cwd, run, { origin: 'http://127.0.0.1:4317' })
    expect(JSON.parse(await readFile(join(cwd, BROWSER_RUNS_DIR, run, 'doctor.json'), 'utf8'))).toEqual({ origin: 'http://127.0.0.1:4317' })
  })
})

describe('recoverStdinDash', () => {
  test('reads back the dash citty parses as an empty value', () => {
    expect(recoverStdinDash('', 'input', ['r', '--step', 'a', '--close', '--input', '-'])).toBe('-')
    expect(recoverStdinDash('step.json', 'input', ['--input', 'step.json'])).toBe('step.json')
    expect(recoverStdinDash('', 'input', ['--input', '-', '--input='])).toBe('')
  })
})
