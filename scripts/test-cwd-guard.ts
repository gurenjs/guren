// Preloaded into `bun test` to make working-directory leaks loud. Bun shares
// one process across test files, so `process.cwd()` is global state and the
// `make:*` generators resolve their output against it. Two invariants:
//   - after every test, cwd is the repo root or a temp directory;
//   - a test file leaves cwd where it found it, and creates none of the
//     directories a scaffolded application owns inside the checkout.

import { afterAll, afterEach, beforeAll } from 'bun:test'
import { existsSync, mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'

import { repoRoot as workspaceRoot } from './workspace-packages.ts'

// Compared against `process.cwd()`, which the OS returns canonicalized — a
// symlinked checkout would otherwise look like a permanent leak.
const repoRoot = realpathSync(workspaceRoot)

// macOS reports /var/folders/... from mkdtemp but /private/var/folders/... from
// realpath, so both spellings have to count as "a temp directory".
const tempRoots = [...new Set([tmpdir(), realpathSync(tmpdir())])]

// `bun test` inside a package legitimately starts there rather than at the repo
// root, so the invariant is "cwd is where the run started", not a fixed path.
const startCwd = realpathSync(process.cwd())

/** Somewhere cwd is legitimate: where the run started, or a temp directory. */
export function isAllowed(cwd: string): boolean {
  if (cwd === startCwd || cwd === repoRoot) return true
  return tempRoots.some((root) => cwd === root || cwd.startsWith(root + sep))
}

// Directories a scaffolded application owns; inside this repository they are
// generator output resolved against the wrong directory. The cwd invariant
// cannot see that case — such a generator never moves cwd at all.
const SCAFFOLD_DIRS = ['app', 'config', 'db', 'modules', 'resources', 'routes', 'lang', 'storage']

// `src/` and `tests/` are scaffold output at the repo root, but every package
// has both — so they are only watched where they cannot legitimately appear.
const ROOT_ONLY_DIRS = ['src', 'tests']

// A leaked cwd lands on a package directory as readily as on the repo root:
// `bun run --cwd packages/cli test` is a supported way to run this suite.
const watchedPaths: string[] = [
  ...SCAFFOLD_DIRS.map((dir) => join(repoRoot, dir)),
  ...ROOT_ONLY_DIRS.map((dir) => join(repoRoot, dir)),
  ...readdirSync(join(repoRoot, 'packages'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => SCAFFOLD_DIRS.map((dir) => join(repoRoot, 'packages', entry.name, dir))),
]

// These paths get deleted, so anything already on disk is exempt. Snapshotting
// spares the watch list from being an accurate inventory of the repo.
const preexisting = new Set(watchedPaths.filter((path) => existsSync(path)))

/** Watched directories that this run created. */
export function strayScaffoldOutput(): string[] {
  return watchedPaths.filter((path) => !preexisting.has(path) && existsSync(path))
}

// A leaked test is sent here rather than back to the repo root, which is the
// one directory a stray `make:*` must not write into.
let quarantine: string | undefined

/** Where the most recent chdir() came from, for blaming a leak. */
let lastChdir: { target: string; error: Error } | undefined
const originalChdir = process.chdir.bind(process)

process.chdir = (directory: string): void => {
  // Constructed eagerly, formatted only on a leak: capturing the frame is far
  // cheaper than stringifying it.
  lastChdir = { target: directory, error: new Error() }
  originalChdir(directory)
}

function blame(): string {
  if (!lastChdir) return '  no chdir() was recorded — cwd changed by something else'
  const frames = (lastChdir.error.stack ?? '')
    .split('\n')
    .filter((line) => !line.includes('test-cwd-guard'))
    .slice(1, 5)
    .join('\n')
  return `  last chdir() -> ${lastChdir.target}\n${frames}`
}

const CWD_ADVICE = [
  '',
  "  process.cwd() is shared by every test file in Bun's single test process,",
  '  and the make:* generators resolve their output against it. Pass an explicit',
  '  cwd (WriterOptions) instead of calling process.chdir(), or restore the',
  '  previous directory in an afterEach/afterAll.',
].join('\n')

let fileStartCwd: string

beforeAll(() => {
  fileStartCwd = process.cwd()
})

// Per test, to name the one that left cwd unusable. One read and a compare.
afterEach(() => {
  const cwd = process.cwd()
  if (isAllowed(cwd)) return

  quarantine ??= mkdtempSync(join(tmpdir(), 'guren-cwd-quarantine-'))
  // Off the bad directory before reporting, so the next test is judged on its own.
  originalChdir(quarantine)

  throw new Error(
    [
      'working directory leaked out of a test',
      `  cwd after this test: ${cwd}`,
      `  expected: ${startCwd} (where this run started) or a directory under ${tempRoots.join(' or ')}`,
      blame(),
      CWD_ADVICE,
    ].join('\n'),
  )
})

// Per file: a stray directory persists, so one scan per file still names the
// culprit at a fraction of the cost. The cwd comparison belongs here too — a
// file may chdir() into its own workspace, but must not hand it to the next.
afterAll(() => {
  const problems: string[] = []

  const stray = strayScaffoldOutput()
  if (stray.length > 0) {
    for (const path of stray) rmSync(path, { recursive: true, force: true })

    problems.push(
      [
        'scaffold output was written into the checkout:',
        ...stray.map((path) => `    ${path.slice(repoRoot.length + 1)}`),
        '',
        '  A make:* generator resolved its output against process.cwd() rather',
        '  than an explicit directory. Pass `cwd` (WriterOptions) pointing at the',
        '  test workspace. Left alone this lands untracked files in the checkout,',
        '  which then break typecheck and get collected as extra test files.',
      ].join('\n'),
    )
  }

  const cwd = process.cwd()
  if (cwd !== fileStartCwd) {
    quarantine ??= mkdtempSync(join(tmpdir(), 'guren-cwd-quarantine-'))
    originalChdir(isAllowed(fileStartCwd) ? fileStartCwd : quarantine)

    problems.push(
      [
        'this test file changed the working directory and did not restore it',
        `  started in: ${fileStartCwd}`,
        `  ended in:   ${cwd}`,
        blame(),
        CWD_ADVICE,
      ].join('\n'),
    )
  }

  if (problems.length > 0) throw new Error(problems.join('\n\n'))
})
