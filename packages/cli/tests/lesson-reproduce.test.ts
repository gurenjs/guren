import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join, sep } from 'node:path'

import { reproduceLesson } from '../src/lesson-reproduce'
import type { CapturedExec } from '../src/subprocess'
import { createTempRoot } from './helpers'

let ROOT: string
let repos = 0

beforeAll(async () => {
  ROOT = await createTempRoot('guren-lesson-reproduce-test-')
})

afterAll(async () => {
  await rm(ROOT, { recursive: true, force: true })
})

async function git(cwd: string, args: string[]): Promise<string> {
  const proc = Bun.spawn(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
  if (code !== 0) throw new Error(`git ${args.join(' ')} failed with code ${code}: ${stderr}`)
  return stdout.trim()
}

async function write(repo: string, files: Record<string, string>): Promise<void> {
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(repo, path)), { recursive: true })
    await writeFile(join(repo, path), content, 'utf8')
  }
}

async function commit(repo: string, files: Record<string, string>): Promise<string> {
  await write(repo, files)
  await git(repo, ['add', '-A'])
  await git(repo, ['commit', '-m', 'change'])
  return git(repo, ['rev-parse', 'HEAD'])
}

const TEST_FILE = 'tests/posts.test.ts'
const ENFORCED_BY = `${TEST_FILE}#fix-page-2`

/** A repository the export accepts: a lockfile, an install, then the commit that removes the defect. */
async function createRepo(): Promise<{ repo: string; fix: string }> {
  const repo = join(ROOT, `repo-${repos++}`)
  await mkdir(repo, { recursive: true })
  await git(repo, ['init', '--initial-branch=main'])
  await git(repo, ['config', 'user.email', 'test@example.com'])
  await git(repo, ['config', 'user.name', 'Test'])
  await commit(repo, { '.gitignore': 'node_modules\n', 'package.json': JSON.stringify({ name: 'app', type: 'module' }), 'bun.lock': '{}', 'src/page.ts': 'export const page = 1\n' })
  const fix = await commit(repo, { 'src/page.ts': 'export const page = 2\n' })
  await mkdir(join(repo, 'node_modules'), { recursive: true })
  // The check as it is now: written after both commits, so it is laid over each export.
  await write(repo, { [TEST_FILE]: "test('page 2 [fix-page-2]', () => {})\n" })
  return { repo, fix }
}

type Case = 'passed' | 'failed' | 'skipped' | 'absent'

function junit(outcome: Case, file = TEST_FILE): string {
  const body = outcome === 'failed' ? '<failure type="AssertionError" />' : outcome === 'skipped' ? '<skipped />' : ''
  const testcase = outcome === 'absent' ? '' : `<testcase name="page 2 [fix-page-2]" classname="" time="0" file="${file}" line="1" assertions="1">${body}</testcase>`
  return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites name="bun test"><testsuite name="${file}" file="${file}">${testcase}</testsuite></testsuites>\n`
}

/** Answers `bun test` with the outcome given for the export it runs in, and records every command. */
function fakeExec(outcomes: { parent: Case; commit: Case }, ran: string[][] = []): CapturedExec {
  return async (command, cwd) => {
    ran.push(command)
    if (command.includes('test')) {
      const side = cwd.split(sep).includes('parent') ? 'parent' : 'commit'
      const outfile = command.find((arg) => arg.startsWith('--reporter-outfile='))!.slice('--reporter-outfile='.length)
      await writeFile(outfile, junit(outcomes[side]), 'utf8')
      return { exitCode: outcomes[side] === 'failed' ? 1 : 0, stdout: '', stderr: '' }
    }
    return { exitCode: 0, stdout: '', stderr: '' }
  }
}

describe('reproduceLesson', () => {
  test('is true only for a test that fails at the parent and passes at the commit', async () => {
    const { repo, fix } = await createRepo()
    const ran: string[][] = []
    const result = await reproduceLesson(repo, fix, ENFORCED_BY, fakeExec({ parent: 'failed', commit: 'passed' }, ran))
    expect(result.value).toBe('true')
    expect(result.because).toContain('fails at the parent')
    // The file path is given with `./`, which `bun test` reads as a path rather than a filter.
    expect(ran.filter((command) => command.includes('test')).map((command) => command[2])).toEqual([`./${TEST_FILE}`, `./${TEST_FILE}`])
  })

  test('is false when the test passes at the parent, and runs nothing at the commit', async () => {
    const { repo, fix } = await createRepo()
    const ran: string[][] = []
    expect((await reproduceLesson(repo, fix, ENFORCED_BY, fakeExec({ parent: 'passed', commit: 'passed' }, ran))).value).toBe('false')
    expect(ran.filter((command) => command.includes('test'))).toHaveLength(1)
  })

  test('is not-run for a test that fails at both, so an environment failure never reads as true', async () => {
    const { repo, fix } = await createRepo()
    const result = await reproduceLesson(repo, fix, ENFORCED_BY, fakeExec({ parent: 'failed', commit: 'failed' }))
    expect(result).toEqual({ value: 'not-run', because: expect.stringContaining('fails at the parent and at') })
  })

  test('is not-run for a skipped case, no carrying case, and a spawn that fails', async () => {
    const { repo, fix } = await createRepo()
    expect((await reproduceLesson(repo, fix, ENFORCED_BY, fakeExec({ parent: 'skipped', commit: 'passed' }))).because).toContain('was skipped')
    expect((await reproduceLesson(repo, fix, ENFORCED_BY, fakeExec({ parent: 'absent', commit: 'passed' }))).because).toContain('no test case in tests/posts.test.ts carries [fix-page-2]')
    const failing: CapturedExec = async () => {
      throw new Error('spawn bun ENOENT')
    }
    expect(await reproduceLesson(repo, fix, ENFORCED_BY, failing)).toEqual({ value: 'not-run', because: 'at the parent: spawn bun ENOENT' })
  })

  test('is not-run before anything runs for a path outside the app, a commit with no parent, and an install the export refuses', async () => {
    const { repo, fix } = await createRepo()
    const never: CapturedExec = async () => {
      throw new Error('ran')
    }
    expect((await reproduceLesson(repo, fix, `../${TEST_FILE}#fix-page-2`, never)).because).toContain('is not a path inside the application')
    const root = await git(repo, ['rev-list', '--max-parents=0', 'HEAD'])
    expect((await reproduceLesson(repo, root, ENFORCED_BY, never)).because).toContain('has no parent')
    await rm(join(repo, 'node_modules'), { recursive: true, force: true })
    expect((await reproduceLesson(repo, fix, ENFORCED_BY, never)).because).toContain('no node_modules is installed here')
  })
})
