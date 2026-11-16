/**
 * `reproduced` on a lesson (RFC 0040 §11): whether the check `enforcedBy` names fires on the
 * parent of the commit that removed the defect and not on that commit, so a check that exists is
 * not mistaken for one that catches the failure. The check is run as it is now, against the code
 * as it was: the file is laid over both exports. A test is the only check run.
 */
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, posix } from 'node:path'

import { runGit } from './changed-files'
import { cliEntry } from './cli-entry'
import { isAppRootRelative } from './app-relative'
import { exportRevisions } from './change/revision-audit'
import { parseEnforcedBy } from './lesson-enforced'
import { acceptanceStatus } from './plan/acceptance-status'
import { bunExecutable, runCaptured, type CapturedExec } from './subprocess'

export type ReproducedValue = 'true' | 'false' | 'not-run'

export interface Reproduced {
  value: ReproducedValue
  because: string
}

// What `bun test` collects (`.test`, `_test`, `.spec`, `_spec`).
const TEST_FILE = /[._](?:test|spec)\.[cm]?[jt]sx?$/u
const CODEGEN_TIMEOUT_MS = 60_000
const TEST_TIMEOUT_MS = 180_000

type Outcome = 'fails' | 'passes' | { unread: string }

const notRun = (because: string): Reproduced => ({ value: 'not-run', because })

/** A spawn that fails (no `bun` on PATH), or an overlay that cannot be written, is a check that could not be run. */
async function runCheck(appDir: string, file: string, name: string, overlay: string, exec: CapturedExec): Promise<Outcome> {
  try {
    return await runCheckIn(appDir, file, name, overlay, exec)
  } catch (error) {
    return { unread: (error as Error).message.split('\n')[0] ?? 'the check could not be run' }
  }
}

async function runCheckIn(appDir: string, file: string, name: string, overlay: string, exec: CapturedExec): Promise<Outcome> {
  const target = join(appDir, file)
  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, overlay)
  // Controllers import `.guren/*.gen.ts`, which a commit need not hold.
  await exec([bunExecutable(), cliEntry(), 'codegen', '--app', appDir], appDir, { timeoutMs: CODEGEN_TIMEOUT_MS })
  const scratch = await mkdtemp(join(tmpdir(), 'guren-lesson-junit-'))
  try {
    const outfile = join(scratch, 'junit.xml')
    // `./`: a bare path is a substring filter to `bun test`, which would also run `modules/*/tests/<file>`.
    const run = await exec([bunExecutable(), 'test', `./${file}`, '--reporter=junit', `--reporter-outfile=${outfile}`], appDir, { timeoutMs: TEST_TIMEOUT_MS })
    if (run.timedOut) return { unread: `bun test did not finish within ${TEST_TIMEOUT_MS / 1000} s` }
    const report = acceptanceStatus(await readFile(outfile, 'utf8').catch(() => undefined), [name])
    if (report.state === 'blocked') return { unread: report.reason }
    if (report.state === 'invalid' && report.errors.some((error) => error.kind === 'id-in-several-files' && error.id === name)) return { unread: `[${name}] is carried by test cases in more than one file` }
    const behaviour = (report.state === 'judged' ? report.behaviours : report.observed).find((entry) => entry.id === name)
    const cases = (behaviour?.cases ?? []).filter((entry) => posix.normalize(entry.file) === file)
    if (cases.length === 0) return { unread: `no test case in ${file} carries [${name}] in its title` }
    if (cases.some((entry) => entry.outcome === 'skipped')) return { unread: `a test case carrying [${name}] was skipped` }
    return cases.some((entry) => entry.outcome === 'failed') ? 'fails' : 'passes'
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
}

/**
 * Runs the named test at `commit^` and at `commit`. `true` needs it failing at the parent and
 * passing at the commit; failing at both says nothing about the defect (no database, a missing
 * file), so it is `not-run`, as is anything that could not be read.
 */
export async function reproduceLesson(cwd: string, commit: string, enforcedBy: string, exec: CapturedExec = runCaptured): Promise<Reproduced> {
  const { file, path, name } = parseEnforcedBy(enforcedBy)
  if (!name) return notRun(`${enforcedBy} names no check`)
  if (!isAppRootRelative(file)) return notRun(`${file} is not a path inside the application`)
  if (!TEST_FILE.test(path)) return notRun(`${file} is not a test file, and only a test is run`)
  const overlay = await readFile(join(cwd, path), 'utf8').catch(() => undefined)
  if (overlay === undefined) return notRun(`${file} could not be read here`)
  const [parent] = (await runGit(cwd, ['rev-parse', '--verify', '--quiet', `${commit}^`])) ?? []
  if (!parent) return notRun(`${commit.slice(0, 12)} has no parent to run the check on`)
  const [prefix = ''] = (await runGit(cwd, ['rev-parse', '--show-prefix'])) ?? []

  const exported = await exportRevisions(cwd, prefix, { parent, commit }, 'run')
  if ('unavailable' in exported) return notRun(exported.unavailable)
  try {
    const before = await runCheck(exported.trees.parent, path, name, overlay, exec)
    if (typeof before === 'object') return notRun(`at the parent: ${before.unread}`)
    if (before === 'passes') return { value: 'false', because: `[${name}] passes at the parent ${parent.slice(0, 12)}, so it does not fail without the commit` }
    const after = await runCheck(exported.trees.commit, path, name, overlay, exec)
    if (typeof after === 'object') return notRun(`at the commit: ${after.unread}`)
    if (after === 'fails') return notRun(`[${name}] fails at the parent and at ${commit.slice(0, 12)} too, so its failure says nothing about the defect`)
    return { value: 'true', because: `[${name}] fails at the parent ${parent.slice(0, 12)} and passes at ${commit.slice(0, 12)}` }
  } finally {
    await exported.dispose()
  }
}
