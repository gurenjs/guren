// Runs the Bun test suites of every workspace package under packages/, derived
// from each package.json. Positional arguments select packages by directory or
// package name; everything after a bare `--` reaches `bun test` verbatim:
//
//   bun run ./scripts/test-packages.ts cli plugin-cloudflare -- -t "rate limit"
//
// Distrust forwarded `--changed`: it selects test files by git diff, but packages/cli's
// tests load @guren/server through the workspace symlink's dist/, which git cannot see.

import { closeSync, mkdtempSync, openSync, readSync, rmSync, writeSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { collectPackages, parseArgs, repoRoot, selectPackages } from './workspace-packages.ts'

// Packages on another runner keep their own root script. An explicit list
// survives a `test` script being reworded; a regex over it would not.
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
// `[test] root` is resolved here and passed as its path filter instead. One
// invocation, so a forwarded `-t <pattern>` matches across packages.
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

// Absolute, because a relative preload path stops resolving once cwd moves.
const cwdGuard = join(import.meta.dir, 'test-cwd-guard.ts')

// Absolute for the same reason.
const fetchGuard = join(import.meta.dir, 'test-global-fetch-guard.ts')

// Guards whose own code lives outside packages/, so a package sweep would never
// run them. Discovered rather than named, so the next one is covered by
// existing; globbed to explicit file paths rather than handing `bun test` a bare
// directory. Unfiltered runs only, so `test:bun cli` stays narrow.
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

// On Linux the child's stdio goes to temp files, not inherited pipes. Under
// `--isolate` Bun 1.3.14 re-creates process.stderr per context as a WriteStream
// registering fd 2 with epoll; on a pipe (any CI runner) that intermittently dies
// with an uncatchable "EEXIST: epoll_ctl" ("N tests failed:" naming none), and
// touching process.stderr reifies that stream. A regular file is what epoll cannot register.
const redirectStdio = process.platform === 'linux'

if (!redirectStdio) {
  const proc = Bun.spawn([process.execPath, ...testArgs], {
    cwd: repoRoot,
    stdout: 'inherit',
    stderr: 'inherit',
  })
  process.exit(await proc.exited)
}

// One fd per channel, opened read-write: the child inherits a duplicate for its
// writes while this process pread()s the same descriptor at explicit offsets.
// Reopening the path to read would be a time-of-check/time-of-use shape.
const stdioDir = mkdtempSync(join(tmpdir(), 'guren-test-stdio-'))
const channels = [
  { fd: openSync(join(stdioDir, 'stdout.log'), 'w+'), offset: 0, targetFd: 1 },
  { fd: openSync(join(stdioDir, 'stderr.log'), 'w+'), offset: 0, targetFd: 2 },
]

// Synchronous reads and writes on raw fds: this process's own process.stdout
// and stderr are the very WriteStreams the redirect exists to avoid.
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
          // reader a beat. Anything else is unwritable output; drop it.
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
