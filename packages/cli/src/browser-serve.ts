/**
 * `guren browser:serve` (RFC 0033 §3): one instance for a verification session, started only
 * after the introspected app shows its database is local. Codegen runs first, since a fresh
 * clone's entry cannot import before it. The child binds loopback on a strict port with the
 * runtime-error collector on; it is ready only once it reports binding that port itself, so a
 * stranger already answering there is never mistaken for it.
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
import { bunExecutable, FORWARDED_SIGNALS, runCaptured, signalChild } from './subprocess'

const SERVE_ENTRY = 'bin/serve.ts'
const HOST = '127.0.0.1'
const CODEGEN_TIMEOUT_MS = 120_000
const INTROSPECT_TIMEOUT_MS = 30_000
const STOP_GRACE_MS = 5_000
/** POSIX only: a detached child leads its own group, so its Vite and workers stop with it. */
const GROUPED = process.platform !== 'win32'

export interface BrowserServeOptions {
  cwd: string
  port?: number
  databaseUrl?: string
  readyTimeoutMs: number
}

export interface BrowserServeHandle {
  ready: { origin: string; pid: number; collector: 'available' | 'unavailable' }
  /** True when the app ended because this process stopped it; false when it ended on its own. */
  ended: Promise<boolean>
}

/** Why the manifest's `database` section stops a start, or `undefined` when it shows a local database. */
export function databaseRefusal(section: ManifestSection<DatabaseEntry | undefined>): string | undefined {
  if (section.status === 'unverified') {
    return `Where the app's database lives is unverified (${section.reason}), so browser:serve does not start it. Fix what \`guren introspect\` reports, then run browser:serve again.`
  }
  if (section.value === undefined) {
    return 'The app binds no database through defineDatabaseConfig(), so browser:serve cannot show where its data lives. The person can start the app and give you its origin for browser:doctor --url; do not start it another way yourself.'
  }
  if (section.value.location === 'local') return undefined
  const why = section.value.reason ? ` ${section.value.reason}` : ''
  return `The app's ${section.value.dialect} database is ${section.value.location}, not local.${why} Ask the person for a local database URL and pass it as --database-url.`
}

/** The port the app's own dev banner says it bound on 127.0.0.1, read from its output so far. */
export function reportedPort(output: string): number | undefined {
  // oxlint-disable-next-line no-control-regex -- strips the banner's ANSI colour codes
  const plain = output.replace(/\u001b\[[0-9;]*m/gu, '')
  const match = /Bound address\s*:\s*http:\/\/127\.0\.0\.1:(\d+)/u.exec(plain)
  return match ? Number(match[1]) : undefined
}

/** The checks of RFC 0033 §3 before anything starts; throws the refusal, naming its remedy. */
async function assertSafeToStart(cwd: string, env: Readonly<Record<string, string>>): Promise<void> {
  if (!existsSync(join(cwd, SERVE_ENTRY))) {
    throw new CliError(`browser:serve starts ${SERVE_ENTRY}, which this app does not have. The person can start the app and give you its origin for browser:doctor --url; do not start it another way yourself.`)
  }
  const codegen = resolveScriptCommand(await readScripts(cwd), 'codegen', codegenFallback())!
  const generated = await runCaptured(codegen.command, cwd, { timeoutMs: CODEGEN_TIMEOUT_MS, processGroup: true })
  if (generated.timedOut || generated.exitCode !== 0) {
    throw new CliError(`${codegen.label} failed, so the app cannot load:\n${outputTail(generated.stderr || generated.stdout).join('\n')}`)
  }
  const introspection = await introspectApp(cwd, { timeoutMs: INTROSPECT_TIMEOUT_MS, env })
  if (introspection.status !== 'ok') {
    throw new CliError(`The app could not be introspected, so where its database lives is unknown: ${introspection.message}`)
  }
  const refusal = databaseRefusal(readManifestSection(introspection.manifest, 'database'))
  if (refusal) throw new CliError(refusal)
}

/** Resolves when `port` (0 for any) can be bound on 127.0.0.1, with the port; rejects when it is taken. */
function claimablePort(port: number): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(port, HOST, () => {
      const address = server.address()
      const bound = typeof address === 'object' && address ? address.port : port
      server.close(() => resolvePort(bound))
    })
  })
}

async function answers(origin: string): Promise<boolean> {
  try {
    const response = await fetch(`${origin}/`, { redirect: 'manual', signal: AbortSignal.timeout(5_000) })
    await response.body?.cancel()
    return true
  } catch {
    return false
  }
}

/**
 * Starts the app and resolves once it reports binding the port and answers there. From the
 * spawn on, SIGINT/SIGTERM/SIGHUP stop the app (a second one kills it) and this process's exit
 * kills it, so no path leaves it running.
 */
export async function startBrowserServe(options: BrowserServeOptions): Promise<BrowserServeHandle> {
  const cwd = resolve(options.cwd)
  // Explicit, so the app's own .env cannot serve under another NODE_ENV than the one judged here.
  const nodeEnv = process.env.NODE_ENV || 'development'
  if (nodeEnv === 'production') {
    throw new CliError('browser:serve does not start an app under NODE_ENV=production. Ask the person to unset it; do not start the app another way.')
  }
  const env: Record<string, string> = { NODE_ENV: nodeEnv, ...(options.databaseUrl ? { DATABASE_URL: options.databaseUrl } : {}) }
  await assertSafeToStart(cwd, env)

  let port: number
  try {
    port = await claimablePort(options.port ?? 0)
  } catch {
    throw new CliError(`Port ${options.port} is already in use on ${HOST}. Stop what listens there, or omit --port to take a free one.`)
  }
  const origin = `http://${HOST}:${port}`

  let output = ''
  let ready = false
  let stopping = false
  const child: ChildProcess = spawn(bunExecutable(), [SERVE_ENTRY], {
    cwd,
    detached: GROUPED,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...env, PORT: String(port), HOST, GUREN_STRICT_PORT: '1', GUREN_MCP: '1', GUREN_DEV_BANNER: '1', FORCE_COLOR: '0', NO_COLOR: '1' },
  })
  const forward = (chunk: Buffer): void => {
    process.stderr.write(chunk)
    if (!ready) output += chunk.toString()
  }
  child.stdout?.on('data', forward)
  child.stderr?.on('data', forward)

  const kill = (): void => signalChild(child, 'SIGKILL', GROUPED)
  const stop = (): void => {
    if (stopping) {
      kill()
      return
    }
    stopping = true
    signalChild(child, 'SIGTERM', GROUPED)
    setTimeout(kill, STOP_GRACE_MS).unref()
  }
  for (const signal of FORWARDED_SIGNALS) process.on(signal, stop)
  process.once('exit', kill)
  const release = (): void => {
    for (const signal of FORWARDED_SIGNALS) process.off(signal, stop)
    process.off('exit', kill)
  }
  let gone = false
  // `close`, not `exit`: the reason the app died is in output that may still be in the pipes at `exit`.
  const ended = new Promise<boolean>((done) => {
    child.once('error', () => { gone = true; release(); done(false) })
    child.once('close', () => { gone = true; release(); done(stopping) })
  })

  const deadline = Date.now() + options.readyTimeoutMs
  while (reportedPort(output) !== port || !(await answers(origin))) {
    if (gone || stopping) {
      await ended
      if (stopping) throw new CliError(`Stopped before ${SERVE_ENTRY} answered on ${origin}.`)
      throw new CliError(`${SERVE_ENTRY} ended before answering on ${origin}:\n${outputTail(output).join('\n')}`)
    }
    if (Date.now() > deadline) {
      stop()
      await ended
      throw new CliError(`${SERVE_ENTRY} did not answer on ${origin} within ${Math.round(options.readyTimeoutMs / 1000)}s, so it was stopped.`)
    }
    await new Promise((wait) => setTimeout(wait, 250))
  }
  ready = true
  output = ''

  const collector = (await fetchRuntimeErrors(origin, { limit: 1 })).status
  return { ready: { origin, pid: child.pid!, collector }, ended }
}
