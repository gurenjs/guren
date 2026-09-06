/**
 * `smoke:tutorial` (RFC 0019 §3): the tutorial chapters under docs/en/tutorials/
 * are the script. Each chapter's `run` blocks execute, `file=` blocks are
 * written, `manual` blocks are skipped, and every chapter ends with `guren gate`
 * and `bun run build` on the app the reader would have. The one substitution:
 * `bunx create-guren-app` becomes this checkout's scaffolder with the app's
 * `@guren/*` ranges rewritten to local builds, the same vendoring
 * `smoke:starter` uses. Everything else runs as written.
 */
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import process from 'node:process'
import { ensureBuiltPackages, rewriteAppDependencies, vendorLocalPackages } from './local-packages'
import {
  cdTarget,
  chapterFiles,
  executableBlocks,
  parseScaffoldCommand,
  parseTutorialBlocks,
  type ExecutableBlock,
  type RunBlock,
} from './tutorial-blocks'

const repoRoot = resolve(import.meta.dir, '../..')
const CLI_BIN = resolve(repoRoot, 'packages/cli/src/bin.ts')
const CREATE_APP = resolve(repoRoot, 'packages/create-app/src/cli.ts')
const BANNER_TIMEOUT_MS = 90_000

interface Background {
  block: RunBlock
  proc: ReturnType<typeof Bun.spawn>
  logPath: string
  port: number
}

interface Session {
  tempRoot: string
  /** Where `run` blocks execute; the workspace until a `cd` block moves it into the app. */
  cwd: string
  /** Set once a scaffold block has run; chapter-end gate and build need it. */
  appDir: string | null
  env: Record<string, string>
  background: Background[]
}

function log(message: string): void {
  console.log(`\n=== ${message} ===`)
}

async function exec(cmd: string[], cwd: string, env: Record<string, string>): Promise<number> {
  console.log(`\n$ (${relativeToTemp(cwd)}) ${cmd.join(' ')}`)
  const proc = Bun.spawn({ cmd, cwd, env, stdout: 'inherit', stderr: 'inherit' })
  return proc.exited
}

async function run(cmd: string[], cwd: string, env: Record<string, string>): Promise<void> {
  const code = await exec(cmd, cwd, env)
  if (code !== 0) throw new Error(`Command failed with exit code ${code}: ${cmd.join(' ')}`)
}

let tempRootForLog = ''
function relativeToTemp(path: string): string {
  return tempRootForLog && path.startsWith(tempRootForLog) ? relative(tempRootForLog, path) || '.' : path
}

function assertInside(root: string, path: string, what: string): void {
  const rel = relative(root, path)
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`${what} escapes the smoke workspace: ${path}`)
  }
}

async function scaffold(session: Session, target: string, flags: string[]): Promise<void> {
  const appDir = resolve(session.cwd, target)
  assertInside(session.tempRoot, appDir, 'Scaffold target')
  // The reader's `--agents` default is claude (create-app's own default); with
  // --no-install the scaffolder cannot run agent:init, so it runs below.
  const agentsIndex = flags.indexOf('--agents')
  const agents = agentsIndex === -1 ? 'claude' : flags[agentsIndex + 1]
  await run(['bun', CREATE_APP, appDir, ...flags, '--no-install'], session.cwd, session.env)

  // Inside the app, as smoke:starter does: a vendored package resolves its own
  // `@guren/*` imports by walking up to the app's node_modules, and a copy
  // placed beside the app finds nothing above it.
  const vendorDir = join(appDir, '.guren-vendor')
  const roots = await vendorLocalPackages(vendorDir)
  // The vendoring copies dist/ only; the published @guren/cli also ships
  // templates/ (its package.json `files`), which agent:sync and agent:init read.
  const cliRoot = roots.get('@guren/cli')
  if (cliRoot) {
    await cp(resolve(repoRoot, 'packages/cli/templates'), join(cliRoot, 'templates'), { recursive: true })
  }
  await rewriteAppDependencies(appDir, roots, 'The tutorial app')
  await run(['bun', 'install'], appDir, session.env)
  await ensureGurenBin(appDir)
  if (agents && agents !== 'none') {
    await run(['bun', CLI_BIN, 'agent:init', '--target', agents], appDir, session.env)
  }
  // The scaffolder's initial commit ran before the rewrite; the reader's tree
  // has no vendor rewrite to commit, so this keeps their `git status` shape.
  // The vendor directory is excluded through .git/info/exclude rather than
  // .gitignore, which the chapters may show the reader.
  if (flags.includes('--git')) {
    await mkdir(join(appDir, '.git/info'), { recursive: true })
    await writeFile(join(appDir, '.git/info/exclude'), '.guren-vendor/\n', { flag: 'a' })
    await run(['git', 'add', '-A'], appDir, session.env)
    await run(['git', 'commit', '-q', '--allow-empty', '-m', 'chore: point @guren/* at the smoke vendor'], appDir, session.env)
  }
  session.appDir = appDir
}

/**
 * The chapters say `bunx guren …`, which bun resolves through
 * `node_modules/.bin/guren`. A `file:` dependency usually links it; nothing
 * guarantees that, and the fallback is a registry lookup for a package that
 * does not exist. So the link is made if missing, never assumed.
 */
async function ensureGurenBin(appDir: string): Promise<void> {
  const binDir = join(appDir, 'node_modules/.bin')
  const link = join(binDir, 'guren')
  if (await Bun.file(link).exists()) return
  const target = join(appDir, 'node_modules/@guren/cli/dist/bin.js')
  if (!(await Bun.file(target).exists())) {
    throw new Error(`Vendored @guren/cli has no dist/bin.js at ${target}`)
  }
  await mkdir(binDir, { recursive: true })
  await symlink(target, link)
  console.log(`Linked node_modules/.bin/guren -> ${relative(appDir, target)}`)
}

async function writeFileBlock(session: Session, path: string, body: string): Promise<void> {
  const destination = resolve(session.cwd, path)
  assertInside(session.tempRoot, destination, `file=${path}`)
  await mkdir(dirname(destination), { recursive: true })
  await writeFile(destination, body.endsWith('\n') ? body : `${body}\n`, 'utf8')
  console.log(`\nwrote ${relativeToTemp(destination)} (${body.split('\n').length} lines)`)
}

async function runShell(session: Session, block: RunBlock): Promise<void> {
  const code = await exec(['bash', '-euo', 'pipefail', '-c', block.body], session.cwd, session.env)
  if (block.mode === 'expect-fail') {
    if (code === 0) throw new Error(`run expect-fail block at line ${block.line} exited 0; the red step did not go red`)
    console.log(`(exited ${code}, as the chapter expects)`)
    return
  }
  if (code !== 0) throw new Error(`run block at line ${block.line} failed with exit code ${code}`)
}

/**
 * Start the block and wait for the app to say which port it bound (the
 * banner's `Bound address` line, read rather than assumed: bin/serve.ts walks
 * past a busy port and only warns). The port is reserved here so two smokes
 * on one machine cannot answer each other's probe; `HOST` pins the bind to
 * the literal the probe addresses.
 */
async function startBackground(session: Session, block: RunBlock, chapter: string): Promise<void> {
  // Named per chapter: two chapters with a `bun run dev` on the same line
  // would otherwise share a log, and the newest banner in it could be the
  // other chapter's server.
  const logPath = join(session.tempRoot, `background-${chapter.replace(/\.md$/u, '')}-${block.line}.log`)
  const logFile = Bun.file(logPath)
  const writer = logFile.writer()
  console.log(`\n$ (${relativeToTemp(session.cwd)}, background) ${block.body}`)
  // A reserved port rather than PORT=0. Measured: under PORT=0 `bun run dev`
  // rebound six times in 30 s (a new port each time) and no probe caught a
  // live listener; on a fixed port it bound once and stayed up.
  const port = await freePort()
  const proc = Bun.spawn({
    cmd: ['bash', '-euo', 'pipefail', '-c', block.body],
    cwd: session.cwd,
    env: { ...session.env, PORT: String(port), HOST: '127.0.0.1', GUREN_STRICT_PORT: '1', GUREN_DEV_BANNER: '1' },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const pump = async (stream: ReadableStream<Uint8Array> | null): Promise<void> => {
    if (!stream) return
    for await (const chunk of stream) {
      writer.write(chunk)
      writer.flush()
    }
  }
  void pump(proc.stdout as ReadableStream<Uint8Array>)
  void pump(proc.stderr as ReadableStream<Uint8Array>)
  session.background.push({ block, proc, logPath, port })

  const deadline = Date.now() + BANNER_TIMEOUT_MS
  let bound: string | null = null
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) break
    bound = boundPort(await readFile(logPath, 'utf8').catch(() => ''))
    if (bound) break
    await Bun.sleep(500)
  }
  if (!bound) {
    console.error(await readFile(logPath, 'utf8').catch(() => ''))
    throw new Error(`background block at line ${block.line} did not report a bound port within ${BANNER_TIMEOUT_MS / 1000}s`)
  }
  // Still read the port the app reports rather than the one it was handed
  // (smoke-golden-path.sh's rule), and retry: a `bun --hot` reload closes the
  // listener for a moment.
  const probeDeadline = Date.now() + 30_000
  let lastError = ''
  while (Date.now() < probeDeadline) {
    bound = boundPort(await readFile(logPath, 'utf8').catch(() => '')) ?? bound
    const url = `http://127.0.0.1:${bound}/`
    try {
      const response = await fetch(url)
      if (response.status === 200) {
        console.log(`background block answered 200 at ${url}`)
        return
      }
      lastError = `answered ${response.status}`
    } catch (error) {
      lastError = String(error)
    }
    await Bun.sleep(500)
  }
  console.error(await readFile(logPath, 'utf8').catch(() => ''))
  throw new Error(`background block at line ${block.line} never answered 200 on its reported port (${lastError})`)
}

/** Last `:<digits>` on the newest `Bound address` banner line, the same rule as smoke-golden-path.sh. */
function boundPort(logText: string): string | null {
  let found: string | null = null
  for (const line of logText.split('\n')) {
    if (!line.includes('Bound address')) continue
    const ports = [...line.matchAll(/:(\d+)/gu)].map((match) => match[1])
    if (ports.length > 0) found = ports[ports.length - 1]
  }
  return found
}

async function freePort(): Promise<number> {
  const { createServer } = await import('node:net')
  return new Promise((resolvePort, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      server.close(() => (port ? resolvePort(port) : reject(new Error('could not reserve a port'))))
    })
  })
}

async function descendants(pid: number): Promise<number[]> {
  const proc = Bun.spawn({ cmd: ['pgrep', '-P', String(pid)], stdout: 'pipe', stderr: 'ignore' })
  const output = await new Response(proc.stdout).text()
  await proc.exited
  const children = output.split('\n').map((line) => Number.parseInt(line, 10)).filter(Number.isInteger)
  const nested = await Promise.all(children.map((child) => descendants(child)))
  return [...children, ...nested.flat()]
}

/** Processes listening on a TCP port, by `lsof`; empty when nothing does or lsof is absent. */
async function listeners(port: number): Promise<number[]> {
  let proc: ReturnType<typeof Bun.spawn>
  try {
    proc = Bun.spawn({ cmd: ['lsof', '-ti', `tcp:${port}`, '-sTCP:LISTEN'], stdout: 'pipe', stderr: 'ignore' })
  } catch {
    return []
  }
  const output = await new Response(proc.stdout as ReadableStream<Uint8Array>).text()
  await proc.exited
  return output.split('\n').map((line) => Number.parseInt(line, 10)).filter(Number.isInteger)
}

function signal(pids: readonly number[], name: 'SIGTERM' | 'SIGKILL'): void {
  for (const pid of pids) {
    try {
      process.kill(pid, name)
    } catch {
      // already gone
    }
  }
}

/**
 * `bun run dev` is a tree (bun run → bun run → bun --hot), and the tree walk
 * alone left a `bun --hot` listener behind, still reloading on every file the
 * next chapter wrote. So the port's listener is killed by name as well, and
 * the stop is not done until nothing listens there: a leaked server would
 * answer a later chapter's probe with the wrong app.
 */
async function stopBackground(session: Session): Promise<void> {
  for (const bg of session.background.splice(0)) {
    const pids = new Set([...(await descendants(bg.proc.pid)), bg.proc.pid, ...(await listeners(bg.port))])
    signal([...pids], 'SIGTERM')
    await Promise.race([bg.proc.exited, Bun.sleep(5_000)])
    signal([...pids, ...(await listeners(bg.port))], 'SIGKILL')
    const deadline = Date.now() + 10_000
    while ((await listeners(bg.port)).length > 0) {
      if (Date.now() > deadline) throw new Error(`a process still listens on port ${bg.port} after stopping the background block from line ${bg.block.line}`)
      await Bun.sleep(250)
    }
    console.log(`stopped background block from line ${bg.block.line}; port ${bg.port} is free (log: ${relativeToTemp(bg.logPath)})`)
  }
}

async function applyBlock(session: Session, block: ExecutableBlock, chapter: string): Promise<void> {
  switch (block.kind) {
    case 'manual':
      console.log(`\n(manual, not executed) ${block.body.split('\n')[0]}`)
      return
    case 'file':
      await writeFileBlock(session, block.path, block.body)
      return
    case 'run': {
      const scaffoldCommand = parseScaffoldCommand(block.body)
      if (scaffoldCommand) {
        await scaffold(session, scaffoldCommand.target, scaffoldCommand.flags)
        return
      }
      const dir = cdTarget(block.body)
      if (dir) {
        const next = resolve(session.cwd, dir)
        assertInside(session.tempRoot, next, 'cd target')
        session.cwd = next
        console.log(`\n$ cd ${dir}`)
        return
      }
      if (block.mode === 'background') {
        await startBackground(session, block, chapter)
        return
      }
      await runShell(session, block)
    }
  }
}

async function runChapter(session: Session, name: string): Promise<void> {
  const file = join('docs/en/tutorials', name)
  const chapter = parseTutorialBlocks(await readFile(join(repoRoot, file), 'utf8'), file)
  if (chapter.issues.length > 0) {
    throw new Error(`${file} does not parse; run audit:tutorial-blocks:\n${chapter.issues.map((issue) => `  line ${issue.line}: ${issue.message}`).join('\n')}`)
  }
  const blocks = executableBlocks(chapter.blocks)
  log(`Chapter ${name}: ${blocks.length} executable block(s)`)
  try {
    for (const block of blocks) {
      await applyBlock(session, block, name)
    }
  } finally {
    await stopBackground(session)
  }
  if (!session.appDir) {
    console.log(`Chapter ${name} scaffolded no app; nothing to gate.`)
    return
  }
  log(`Chapter ${name}: gate and build`)
  await run(['bun', CLI_BIN, 'gate'], session.appDir, session.env)
  await run(['bun', 'run', 'build'], session.appDir, session.env)
}

async function main(): Promise<void> {
  await ensureBuiltPackages()
  const through = process.env.GUREN_TUTORIAL_THROUGH
  const names = (await chapterFiles(join(repoRoot, 'docs/en/tutorials')))
    .filter((name) => !through || name.slice(0, 2) <= through)
  if (names.length === 0) throw new Error('No chapters found under docs/en/tutorials (files named NN-<slug>.md).')

  const tempRoot = await mkdtemp(join(tmpdir(), 'guren-tutorial-'))
  tempRootForLog = tempRoot
  const workspace = join(tempRoot, 'workspace')
  const runtimeTempDir = join(tempRoot, '.tmp')
  const bunInstallCacheDir = join(tempRoot, '.bun-install-cache')
  await mkdir(workspace, { recursive: true })
  await mkdir(runtimeTempDir, { recursive: true })
  await mkdir(bunInstallCacheDir, { recursive: true })

  const session: Session = {
    tempRoot,
    cwd: workspace,
    appDir: null,
    background: [],
    env: {
      ...(process.env as Record<string, string>),
      TMPDIR: runtimeTempDir,
      BUN_INSTALL_CACHE_DIR: bunInstallCacheDir,
      // The chapters commit; a CI runner has no identity of its own.
      GIT_AUTHOR_NAME: 'Guren Tutorial',
      GIT_AUTHOR_EMAIL: 'tutorial@guren.dev',
      GIT_COMMITTER_NAME: 'Guren Tutorial',
      GIT_COMMITTER_EMAIL: 'tutorial@guren.dev',
    },
  }

  let failed = false
  try {
    log(`Tutorial smoke: ${names.join(', ')} in ${tempRoot}`)
    for (const name of names) {
      await runChapter(session, name)
    }
    log('Tutorial smoke PASSED')
  } catch (error) {
    failed = true
    throw error
  } finally {
    await stopBackground(session)
    if (process.env.GUREN_KEEP_SMOKE_DIR === '1' || failed) {
      console.log(`\nKeeping tutorial workspace: ${tempRoot}`)
    } else {
      await rm(tempRoot, { recursive: true, force: true })
    }
  }
}

await main()
