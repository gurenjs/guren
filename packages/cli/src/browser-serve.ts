/**
 * `guren browser:serve` (RFC 0033 §3): one instance for a verification session, started only
 * after the introspected app shows its database is local. Codegen runs first, since a fresh
 * clone's entry cannot import before it. The child binds loopback on a strict port with the
 * runtime-error collector on; this process prints its origin as one JSON line on stdout,
 * forwards the child's output to stderr, and stops only the child it spawned.
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createServer } from 'node:net'
import { join, resolve } from 'node:path'

import type { DatabaseEntry } from '@guren/server'

import { CliError } from './cli-error'
import { codegenFallback, outputTail, readScripts, resolveScriptCommand } from './command-output'
import { introspectApp } from './introspect'
import { readManifestSection, type ManifestSection } from './manifest-section'
import { fetchRuntimeErrors } from './runtime-errors'
import { bunExecutable, runCaptured } from './subprocess'

const SERVE_ENTRY = 'bin/serve.ts'
const HOST = '127.0.0.1'
const CODEGEN_TIMEOUT_MS = 120_000
const INTROSPECT_TIMEOUT_MS = 30_000
const STOP_GRACE_MS = 5_000

export interface BrowserServeOptions {
  cwd: string
  port?: number
  databaseUrl?: string
  readyTimeoutMs: number
}

export interface BrowserServeReady {
  origin: string
  pid: number
  collector: 'available' | 'unavailable'
}

/** The checks of RFC 0033 §3 before anything starts; throws the refusal, naming its remedy. */
async function assertSafeToStart(cwd: string, env: Readonly<Record<string, string>>): Promise<void> {
  if (process.env.NODE_ENV === 'production') {
    throw new CliError('browser:serve does not start an app under NODE_ENV=production. Unset it, or point browser:doctor at a server you started with --url.')
  }
  if (!existsSync(join(cwd, SERVE_ENTRY))) {
    throw new CliError(`browser:serve starts ${SERVE_ENTRY}, which this app does not have. Start the app yourself and pass its origin to browser:doctor --url.`)
  }

  const codegen = resolveScriptCommand(await readScripts(cwd), 'codegen', codegenFallback())!
  const generated = await runCaptured(codegen.command, cwd, { timeoutMs: CODEGEN_TIMEOUT_MS, processGroup: true })
  if (generated.timedOut || generated.exitCode !== 0) {
    throw new CliError(`${codegen.label} failed, so the app cannot load:\n${outputTail(generated.stderr || generated.stdout).join('\n')}`)
  }

  const introspection = await introspectApp(cwd, { fresh: true, timeoutMs: INTROSPECT_TIMEOUT_MS, env })
  if (introspection.status !== 'ok') {
    throw new CliError(`The app could not be introspected, so where its database lives is unknown: ${introspection.message}`)
  }
  const refusal = databaseRefusal(readManifestSection(introspection.manifest, 'database'))
  if (refusal) throw new CliError(refusal)
}

/** Why the manifest's `database` section stops a start, or `undefined` when it shows a local database. */
export function databaseRefusal(section: ManifestSection<DatabaseEntry | undefined>): string | undefined {
  if (section.status === 'unverified') {
    return `Where the app's database lives is unverified (${section.reason}), so browser:serve does not start it. Fix what \`guren introspect\` reports, then run browser:serve again.`
  }
  if (section.value === undefined) {
    return 'The app binds no database through defineDatabaseConfig(), so browser:serve cannot show where its data lives. Start the app yourself and pass its origin to browser:doctor --url.'
  }
  if (section.value.location === 'local') return undefined
  const why = section.value.reason ? ` ${section.value.reason}` : ''
  return `The app's ${section.value.dialect} database is ${section.value.location}, not local.${why} Pass --database-url with a local database.`
}

function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, HOST, () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      server.close(() => resolvePort(port))
    })
  })
}

async function answers(origin: string): Promise<boolean> {
  try {
    await fetch(`${origin}/`, { redirect: 'manual', signal: AbortSignal.timeout(2_000) })
    return true
  } catch {
    return false
  }
}

function stopChild(child: ChildProcess): Promise<void> {
  return new Promise((done) => {
    if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) {
      done()
      return
    }
    const pid = child.pid
    const kill = (signal: NodeJS.Signals): void => {
      try { process.kill(-pid, signal) } catch { /* the group is already gone */ }
    }
    const force = setTimeout(() => kill('SIGKILL'), STOP_GRACE_MS)
    child.once('exit', () => {
      clearTimeout(force)
      done()
    })
    kill('SIGTERM')
  })
}

/** Starts the app and resolves once it answers; `exited` settles when the child does. */
export async function startBrowserServe(options: BrowserServeOptions): Promise<{ ready: BrowserServeReady; exited: Promise<number>; stop: () => Promise<void> }> {
  const cwd = resolve(options.cwd)
  const overrides: Record<string, string> = options.databaseUrl ? { DATABASE_URL: options.databaseUrl } : {}
  await assertSafeToStart(cwd, overrides)

  const port = options.port ?? await freePort()
  const origin = `http://${HOST}:${port}`
  let tail = ''
  const child = spawn(bunExecutable(), [SERVE_ENTRY], {
    cwd,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      ...overrides,
      PORT: String(port),
      HOST,
      GUREN_STRICT_PORT: '1',
      GUREN_MCP: '1',
      GUREN_BROWSER_SEED: '1',
    },
  })
  const forward = (chunk: Buffer): void => {
    process.stderr.write(chunk)
    tail = `${tail}${chunk.toString()}`.slice(-4_000)
  }
  child.stdout?.on('data', forward)
  child.stderr?.on('data', forward)
  const exited = new Promise<number>((done) => child.once('exit', (code) => done(code ?? 1)))
  const stop = (): Promise<void> => stopChild(child)

  const deadline = Date.now() + options.readyTimeoutMs
  while (!(await answers(origin))) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new CliError(`${SERVE_ENTRY} exited with code ${child.exitCode ?? child.signalCode} before answering on ${origin}:\n${tail.trim().split('\n').slice(-20).join('\n')}`)
    }
    if (Date.now() > deadline) {
      await stop()
      throw new CliError(`${SERVE_ENTRY} did not answer on ${origin} within ${Math.round(options.readyTimeoutMs / 1000)}s, so it was stopped.`)
    }
    await new Promise((wait) => setTimeout(wait, 250))
  }

  const collector = (await fetchRuntimeErrors(origin, { limit: 1 })).status
  return { ready: { origin, pid: child.pid!, collector }, exited, stop }
}
