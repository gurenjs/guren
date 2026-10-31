import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'

import { BROWSER_RUNS_DIR, beginRun, closeStep, compareRunNames, lowerResult, openStep, screenshotChange, screenshotChangeLines, writeDoctorEvidence, type ClosedStep, type RecordDeps } from '../src/browser-record'
import { recoverStdinDash } from '../src/plan/feedback'
import type { RuntimeErrorEvent } from '../src/runtime-error-window'
import type { RuntimeErrorQuery } from '../src/runtime-errors'

let cwd: string
beforeEach(async () => { cwd = await mkdtemp(join(tmpdir(), 'guren-browser-record-')) })
afterEach(async () => { await rm(cwd, { recursive: true, force: true }) })

function event(sequence: number): RuntimeErrorEvent {
  return { sessionId: 's1', sequence, occurredAt: '2026-10-16T00:00:00.000Z', method: 'GET', route: { method: 'GET', pattern: '/' }, correlation: 'matched', status: 500, category: 'server-error', frames: [] }
}

function deps(events: RuntimeErrorEvent[], options: { unavailable?: boolean; commit?: { rev: string; dirty: boolean } | null; now?: string } = {}): RecordDeps {
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
    commit: async () => (options.commit === undefined ? { rev: 'abc123', dirty: false } : options.commit),
    now: () => new Date(options.now ?? '2026-10-16T10:42:07.123Z'),
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
    const { step } = await closeStep(cwd, run, 'AC-posts-1', { ...passing, screenshots: ['screenshots/after.png'] }, deps(events))

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
    const { step } = await closeStep(cwd, run, 'AC-posts-1', passing, deps([]))
    expect(step).toMatchObject({ result: 'inconclusive', cli: { runtimeErrors: { window: 'unavailable', events: 0 } } })
  })

  test('refuses an unopened step, a screenshot outside the run, an unknown field and a step recorded twice', async () => {
    const { run } = await beginRun(cwd, { url: 'http://127.0.0.1:4317', feature: 'Posts' }, deps([]))
    await expect(closeStep(cwd, run, 'missing', passing, deps([]))).rejects.toThrow('was never opened')
    await openStep(cwd, run, 'AC-posts-1', deps([]))
    await expect(closeStep(cwd, run, 'AC-posts-1', { ...passing, screenshots: ['../run.json'] }, deps([]))).rejects.toThrow('is not a file inside')
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
    const { step } = await closeStep(relativeRoot, run, 'AC-posts-1', { ...passing, screenshots: ['screenshots/ok.png'] }, deps([]))
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

describe('screenshots compared with earlier runs (RFC 0033 §12.3)', () => {
  interface Recording {
    at: string
    shots: Record<string, string>
    feature?: string
    step?: string
    commit?: { rev: string; dirty: boolean } | null
    result?: 'pass' | 'fail'
    serverError?: boolean
  }

  async function record(options: Recording): Promise<ClosedStep> {
    const events: RuntimeErrorEvent[] = []
    const d = deps(events, { commit: options.commit, now: options.at })
    const { run } = await beginRun(cwd, { url: 'http://127.0.0.1:4317', feature: options.feature ?? 'Posts' }, d)
    const step = options.step ?? 'AC-posts-1'
    await openStep(cwd, run, step, d)
    for (const [name, bytes] of Object.entries(options.shots)) await writeFile(join(cwd, BROWSER_RUNS_DIR, run, 'screenshots', name), bytes)
    if (options.serverError) events.push(event(1))
    return closeStep(cwd, run, step, { ...passing, result: options.result ?? 'pass', screenshots: Object.keys(options.shots).map((name) => `screenshots/${name}`) }, d)
  }

  /** The comparison never moves a result: what lowerResult() made of the window is what is stored. */
  function expectResultUntouched(closed: ClosedStep, serverError = false) {
    if (serverError) {
      expect(closed.step).toMatchObject({ result: 'fail', lowered: '1 server error(s) during the step.' })
    } else {
      expect(closed.step.result).toBe('pass')
      expect(closed.step).not.toHaveProperty('lowered')
    }
  }

  test('reports a screenshot no earlier run holds as new', async () => {
    const closed = await record({ at: '2026-10-16T10:00:00Z', shots: { 'post-form.png': 'a' } })
    expect(closed.step.cli.screenshots[0]).not.toHaveProperty('previous')
    expect(screenshotChangeLines(closed)).toEqual(['screenshots/post-form.png: new'])
    expectResultUntouched(closed)
  })

  test('reports equal digests as unchanged, and keeps a server error lowering the result', async () => {
    const first = await record({ at: '2026-10-16T10:00:00Z', shots: { 'post-form.png': 'a' } })
    const closed = await record({ at: '2026-10-16T11:00:00Z', shots: { 'post-form.png': 'a' }, serverError: true })
    expect(closed.step.cli.screenshots[0]!.previous).toEqual({ run: first.run, sha256: first.step.cli.screenshots[0]!.sha256, commit: { rev: 'abc123', dirty: false } })
    expect(screenshotChangeLines(closed)).toEqual([`screenshots/post-form.png: unchanged since ${first.run}`])
    expectResultUntouched(closed, true)
    const stored = JSON.parse(await readFile(join(cwd, BROWSER_RUNS_DIR, closed.run, 'run.json'), 'utf8')) as { steps: Array<{ cli: { screenshots: Array<{ previous?: { run: string } }> } }> }
    expect(stored.steps[0]!.cli.screenshots[0]!.previous?.run).toBe(first.run)
  })

  test('reports a changed digest with both paths, whatever result the earlier run had', async () => {
    const first = await record({ at: '2026-10-16T10:00:00Z', shots: { 'post-form.png': 'a' }, commit: { rev: 'abc123', dirty: false }, result: 'fail' })
    const closed = await record({ at: '2026-10-16T11:00:00Z', shots: { 'post-form.png': 'b' }, commit: { rev: 'def456', dirty: false } })
    expect(screenshotChange(closed.commit, closed.step.cli.screenshots[0]!)).toBe('changed')
    expect(screenshotChangeLines(closed)).toEqual([
      `screenshots/post-form.png: changed since ${first.run}: ${BROWSER_RUNS_DIR}/${first.run}/screenshots/post-form.png ${BROWSER_RUNS_DIR}/${closed.run}/screenshots/post-form.png`,
    ])
    expectResultUntouched(closed)
  })

  test('says a change happened at the same commit only when both runs name one rev with clean trees', async () => {
    const first = await record({ at: '2026-10-16T10:00:00Z', shots: { 'post-form.png': 'a' } })
    const closed = await record({ at: '2026-10-16T11:00:00Z', shots: { 'post-form.png': 'b' } })
    expect(screenshotChange(closed.commit, closed.step.cli.screenshots[0]!)).toBe('changed-same-commit')
    expect(screenshotChangeLines(closed)[0]).toStartWith(`screenshots/post-form.png: changed at the same commit since ${first.run}`)
    expectResultUntouched(closed)

    const shot = closed.step.cli.screenshots[0]!
    expect(screenshotChange({ rev: 'abc123', dirty: true }, shot)).toBe('changed')
    expect(screenshotChange(null, shot)).toBe('changed')
    expect(screenshotChange({ rev: 'abc123', dirty: false }, { ...shot, previous: { ...shot.previous!, commit: { rev: 'abc123', dirty: true } } })).toBe('changed')
    expect(screenshotChange({ rev: 'abc123', dirty: false }, { ...shot, previous: { ...shot.previous!, commit: null } })).toBe('changed')
  })

  test('skips and counts an earlier run.json that does not read, never comparing it', async () => {
    const corrupt = async (at: string) => {
      const { run } = await beginRun(cwd, { url: 'http://127.0.0.1:4317', feature: 'Posts' }, deps([], { now: at }))
      await writeFile(join(cwd, BROWSER_RUNS_DIR, run, 'run.json'), '{ not json')
    }
    await corrupt('2026-10-16T09:00:00Z')
    const paired = await record({ at: '2026-10-16T10:00:00Z', shots: { 'post-form.png': 'a' } })
    await corrupt('2026-10-16T11:00:00Z')
    await mkdir(join(cwd, BROWSER_RUNS_DIR, '2026-10-16T11-30-00Z-posts'))
    const closed = await record({ at: '2026-10-16T12:00:00Z', shots: { 'post-form.png': 'a' } })
    expect(closed.step.cli.screenshots[0]!.previous?.run).toBe(paired.run)
    expect(closed.unreadableRuns).toBe(1)
    expect(screenshotChangeLines(closed)).toEqual([
      `screenshots/post-form.png: unchanged since ${paired.run}`,
      '1 earlier run(s) of Posts could not be read and were not compared.',
    ])
    expectResultUntouched(closed)
  })

  test('pairs only the same feature, step and path, and only with a run before this one', async () => {
    const paired = await record({ at: '2026-10-16T10:00:00Z', shots: { 'post-form.png': 'a' } })
    await record({ at: '2026-10-16T10:10:00Z', shots: { 'post-form.png': 'b' }, feature: 'Comments' })
    await record({ at: '2026-10-16T10:20:00Z', shots: { 'post-form.png': 'b' }, feature: 'posts' })
    await record({ at: '2026-10-16T10:30:00Z', shots: { 'post-form.png': 'b' }, step: 'AC-posts-2' })
    await record({ at: '2026-10-16T10:40:00Z', shots: { 'post-list.png': 'b' } })
    const events: RuntimeErrorEvent[] = []
    const d = deps(events, { now: '2026-10-16T11:00:00Z' })
    const { run } = await beginRun(cwd, { url: 'http://127.0.0.1:4317', feature: 'Posts' }, d)
    await record({ at: '2026-10-16T12:00:00Z', shots: { 'post-form.png': 'b' } })
    await openStep(cwd, run, 'AC-posts-1', d)
    await writeFile(join(cwd, BROWSER_RUNS_DIR, run, 'screenshots', 'post-form.png'), 'a')
    await writeFile(join(cwd, BROWSER_RUNS_DIR, run, 'screenshots', 'post-saved.png'), 'a')
    const closed = await closeStep(cwd, run, 'AC-posts-1', { ...passing, screenshots: ['screenshots/post-form.png', 'screenshots/post-saved.png'] }, d)
    expect(closed.step.cli.screenshots.map((shot) => shot.previous?.run)).toEqual([paired.run, undefined])
    expect(screenshotChangeLines(closed)).toEqual([`screenshots/post-form.png: unchanged since ${paired.run}`, 'screenshots/post-saved.png: new'])
    expect(closed.unreadableRuns).toBe(0)
    expectResultUntouched(closed)
  })

  test('orders run names as --begin took them within one second', () => {
    const names = ['2026-10-16T10-00-00Z-posts-10', '2026-10-16T10-00-01Z-posts', '2026-10-16T10-00-00Z-posts-2', '2026-10-16T10-00-00Z-posts']
    expect(names.sort(compareRunNames)).toEqual(['2026-10-16T10-00-00Z-posts', '2026-10-16T10-00-00Z-posts-2', '2026-10-16T10-00-00Z-posts-10', '2026-10-16T10-00-01Z-posts'])
  })
})

describe('recoverStdinDash', () => {
  test('reads back the dash citty parses as an empty value', () => {
    expect(recoverStdinDash('', 'input', ['r', '--step', 'a', '--close', '--input', '-'])).toBe('-')
    expect(recoverStdinDash('step.json', 'input', ['--input', 'step.json'])).toBe('step.json')
    expect(recoverStdinDash('', 'input', ['--input', '-', '--input='])).toBe('')
  })
})
