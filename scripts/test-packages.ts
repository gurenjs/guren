// Runs the Bun test suites of every workspace package under packages/.
//
// The package list is derived from each package.json rather than
// hand-maintained: any package whose `test` script uses Bun's runner is picked
// up automatically, so adding a package (a plugin, for example) needs no change
// here or in the root package.json scripts.
//
// Packages on a different runner (@guren/testing uses vitest) are skipped —
// they have their own root script.
//
//   bun run ./scripts/test-packages.ts                   # test everything
//   bun run ./scripts/test-packages.ts --list            # print the packages only
//   bun run ./scripts/test-packages.ts cli plugin-cloudflare
//   bun run ./scripts/test-packages.ts -- -t "rate limit"  # forward flags to bun test
//
// Positional arguments select packages by directory name or package name.
// Everything after a bare `--` is forwarded to `bun test` verbatim.

import { closeSync, mkdtempSync, openSync, readSync, rmSync, writeSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { collectPackages, parseArgs, repoRoot, selectPackages } from './workspace-packages.ts'

// Packages on a runner other than Bun's own (@guren/testing uses vitest) keep
// their own root script instead of joining this one. An explicit list survives
// a `test` script being reworded — a regex sniffing the script string would not.
const nonBunTestPackages = new Set(['@guren/testing'])

const { flags, positionals: selectors, forwarded } = parseArgs(
  process.argv.slice(2),
  ['list'],
)
const listOnly = flags.list

const bunTestPackages = (await collectPackages()).filter(
  (pkg) => pkg.scripts.test && !nonBunTestPackages.has(pkg.name),
)
const targets = selectPackages(bunTestPackages, selectors)

if (listOnly) {
  for (const pkg of targets) console.log(pkg.name)
  process.exit(0)
}

if (targets.length === 0) {
  console.error('[test] no packages with a `bun test` script were found')
  process.exit(1)
}

// A single root-cwd run ignores per-package bunfig.toml, so each package's
// `[test] root` (create-app uses it to keep the *.test.ts files its
// templates ship for scaffolded apps out of the monorepo suite) is resolved
// here and passed as the package's path filter instead. One invocation, so
// forwarded flags like `-t <pattern>` keep matching across packages rather
// than failing in every package the pattern misses.
async function testPathFor(pkg: { dir: string; relativeDir: string }): Promise<string> {
  try {
    const bunfig = await Bun.file(`${pkg.dir}/bunfig.toml`).text()
    const root = bunfig.match(/^\s*root\s*=\s*"([^"]+)"/m)?.[1]
    if (root) return `${pkg.relativeDir}/${root}`
  } catch {
    // no bunfig — the package directory itself is the test root
  }
  return pkg.relativeDir
}

// Fails any test that leaves process.cwd() somewhere unexpected, or scaffolds
// into the checkout. Absolute, because a relative preload path stops resolving
// the moment cwd moves.
const cwdGuard = join(import.meta.dir, 'test-cwd-guard.ts')

// Fails any test file that leaves globalThis.fetch replaced. Absolute for the
// same reason as the guard above.
const fetchGuard = join(import.meta.dir, 'test-global-fetch-guard.ts')

// Detectors whose own code lives outside packages/, so a package sweep would
// never run them — and a detector that silently stops detecting is worth
// nothing. The smoke package list is here for the same reason: the gates that
// consume it take ten minutes each, so nothing else would notice it narrowing.
// Included only on an unfiltered run, so `test:bun cli` stays narrow.
//
// Discovered rather than named, so the next scripts-level guard is covered by
// existing — a hand-kept list is the shape local-packages.ts exists to end.
// Globbed here rather than passed to `bun test` as a bare `scripts/` directory:
// what reaches the command line stays a list of explicit file paths, which is
// what it was before, so this cannot change how bun resolves its arguments.
const guardTests = selectors.length === 0 ? await collectScriptTests() : []

async function collectScriptTests(): Promise<string[]> {
  const found: string[] = []
  for await (const path of new Bun.Glob('scripts/**/*.test.ts').scan({ cwd: repoRoot })) {
    found.push(path)
  }
  if (found.length === 0) {
    throw new Error('No scripts-level guard tests found — the glob no longer matches this layout.')
  }
  return found.sort()
}

const testArgs = [
  'test',
  '--isolate',
  '--preload',
  cwdGuard,
  '--preload',
  fetchGuard,
  ...forwarded,
  ...(await Promise.all(targets.map(testPathFor))),
  ...guardTests,
]

console.log(`[test] ${targets.map((pkg) => pkg.name).join(', ')}`)

// On Linux the child's stdout/stderr go to temp files, pumped back to this
// process's own fds — NOT inherited pipes. Under `--isolate` every test file
// gets a fresh globals context, and Bun re-creates process.stderr lazily per
// context as a WriteStream whose fast path registers fd 2 with epoll. When
// fd 2 is a pipe (any CI runner), that registration intermittently collides
// with one another sink still holds and the construction dies with "EEXIST:
// file already exists, epoll_ctl" — uncatchably: it surfaces as an "Unhandled
// error between tests", kills the whole file mid-load, and the summary says
// "N tests failed:" while naming none. It cannot be defused from inside the
// test process either: reading, defineProperty-ing or even delete-ing
// process.stderr reifies the lazy property first, constructing the exact
// stream whose construction is the hazard (each variant verified on Bun
// 1.3.14). A regular file is the one stdio target epoll cannot register, so
// redirecting removes the race structurally. macOS keeps inherit: kqueue has
// no such failure mode, and a local TTY keeps its colors.
const redirectStdio = process.platform === 'linux'

if (!redirectStdio) {
  const proc = Bun.spawn([process.execPath, ...testArgs], {
    cwd: repoRoot,
    stdout: 'inherit',
    stderr: 'inherit',
  })
  process.exit(await proc.exited)
}

// One fd per channel, opened read-write: the child inherits a duplicate for
// its writes while this process pread()s the same descriptor at explicit
// offsets. Reopening the path for reading would work too, but a second open
// of a just-created path is a textbook time-of-check/time-of-use shape.
const stdioDir = mkdtempSync(join(tmpdir(), 'guren-test-stdio-'))
const channels = [
  { fd: openSync(join(stdioDir, 'stdout.log'), 'w+'), offset: 0, targetFd: 1 },
  { fd: openSync(join(stdioDir, 'stderr.log'), 'w+'), offset: 0, targetFd: 2 },
]

// Forwarded with synchronous reads and writes on raw fds: this process's own
// process.stdout/stderr are the same lazy WriteStreams the redirect exists to
// avoid, so the pump must not touch them.
const chunk = Buffer.alloc(65536)
function pump(): void {
  for (const channel of channels) {
    for (;;) {
      const bytes = readSync(channel.fd, chunk, 0, chunk.length, channel.offset)
      if (bytes <= 0) break
      channel.offset += bytes
      let written = 0
      while (written < bytes) {
        try {
          written += writeSync(channel.targetFd, chunk, written, bytes - written)
        } catch (error) {
          // EAGAIN: our own stdio can be a full non-blocking pipe — give its
          // reader a beat instead of spinning hot. Anything else is
          // unwritable output; drop it rather than wedge the run.
          if ((error as NodeJS.ErrnoException).code === 'EAGAIN') Bun.sleepSync(1)
          else written = bytes
        }
      }
    }
  }
}

const proc = Bun.spawn([process.execPath, ...testArgs], {
  cwd: repoRoot,
  stdout: channels[0]!.fd,
  stderr: channels[1]!.fd,
})

const pumpTimer = setInterval(pump, 50)
const exitCode = await proc.exited
clearInterval(pumpTimer)
pump()

for (const channel of channels) {
  closeSync(channel.fd)
}
rmSync(stdioDir, { recursive: true, force: true })

process.exit(exitCode)
