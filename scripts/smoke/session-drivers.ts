/**
 * RFC 0020 Part 5: a scaffolded app's `SESSION_DRIVER` selects the store it
 * names. A boot alone cannot show that — a name that silently fell back boots
 * just as cleanly — so each driver is judged by an authenticated round-trip
 * *and* by whether it left a row in the app's `sessions` table, and a name no
 * store declares has to fail the boot with the message that says so.
 */
import { Database } from 'bun:sqlite'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import process from 'node:process'

/** The scaffold's cookie name (`DEFAULT_COOKIE_NAME`) and the CSRF cookie the middleware issues. */
const SESSION_COOKIE = 'guren.session'
const XSRF_COOKIE = 'XSRF-TOKEN'

/**
 * `localhost` resolves to ::1 first on macOS while a 0.0.0.0 bind is IPv4-only,
 * so the bind address is pinned and every request below addresses that literal.
 */
const RUNTIME_HOST = '127.0.0.1'

const BOOT_TIMEOUT_MS = 60_000

/**
 * Bounds on waits that a torn pipe or a wedged child could otherwise hang
 * forever, in a gate whose every failing assertion runs through them.
 */
const DRAIN_SETTLE_MS = 5_000
const STOP_TIMEOUT_MS = 15_000

/**
 * Spread last into every child, so an ambient NODE_ENV cannot win: under `test`
 * `config/database.ts` opens guren.test.db while the row assertions below read
 * guren.db. The CLI runs from this checkout while the app resolves @guren/orm
 * from its own node_modules, so two ORM copies legitimately coexist here.
 */
const DEVELOPMENT_ENV = {
  NODE_ENV: 'development',
  GUREN_QUIET_DUPLICATE_ORM: '1',
}

export type SmokeRunner = (cmd: string[], cwd: string, envOverrides?: Record<string, string>) => Promise<void>

export interface SessionDriverProbeOptions {
  appDir: string
  /** This checkout's CLI entry, for `db:migrate` — `bunx guren` is not resolvable in CI. */
  cliBin: string
  /** The smoke's TMPDIR/cache pins, spread into every child. */
  env: Record<string, string>
  run: SmokeRunner
}

/**
 * What each store the scaffold may offer must look like from outside. Every
 * store the app declares needs an entry here, but an entry with no declaration
 * is only a store this scaffold has not adopted yet.
 */
const EXPECTED_SESSION_ROWS: Record<string, 'written' | 'none'> = {
  database: 'written',
  memory: 'none',
  // The session travels in the cookie itself, so it reaches no sessions table.
  cookie: 'none',
}

/**
 * What a session-scaffolded app always declares: `database` from
 * config/session.ts, `memory` from SessionManager itself. Driving the loop from
 * the declared list is what turns an unadopted store into a skip; without this,
 * a dropped store would shrink the loop to nothing just as quietly.
 */
const REQUIRED_SESSION_STORES = ['memory', 'database']

/**
 * Separates a cookie-borne session from an id, which no row count can. Every
 * keyed store signs the same UUID, so a fallback is a fixed 92 characters —
 * ratio 1.00 exactly. The cookie store floors at base64url(12-byte IV +
 * 16-byte tag + smallest JSON) ≈ 146, or 1.59x; measured 167. The threshold
 * is their geometric midpoint, under that floor to allow a smaller session.
 */
const COOKIE_STATE_LENGTH_FACTOR = 1.25

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message)
  }
}

class CookieJar {
  private readonly values = new Map<string, string>()

  absorb(response: Response): void {
    for (const raw of response.headers.getSetCookie()) {
      const pair = raw.split(';')[0] ?? ''
      const separator = pair.indexOf('=')
      if (separator < 0) continue
      const name = pair.slice(0, separator).trim()
      const value = pair.slice(separator + 1).trim()
      if (value === '') {
        this.values.delete(name)
      } else {
        this.values.set(name, value)
      }
    }
  }

  /** Percent-decoded: cookies are written encoded, headers and bodies carry the raw token. */
  get(name: string): string | undefined {
    const value = this.values.get(name)
    return value === undefined ? undefined : decodeURIComponent(value)
  }

  header(): string {
    return [...this.values].map(([name, value]) => `${name}=${value}`).join('; ')
  }
}

interface StartedApp {
  proc: Bun.Subprocess
  /**
   * Only complete after `drained()`: `proc.exitCode` flipping and the pipes
   * finishing delivery are scheduled independently, so a needle asserted on a
   * tail that has not arrived yet blames the app for a defect it does not have.
   */
  output: () => string
  drained: () => Promise<void>
  stop: () => Promise<void>
}

interface RunningApp extends StartedApp {
  url: string
}

/** Never rejects: an await on the returned promise sits in failure paths that must not be masked. */
function drain(stream: ReadableStream<Uint8Array> | undefined, sink: { text: string }): Promise<void> {
  if (!stream) return Promise.resolve()
  return (async () => {
    const decoder = new TextDecoder()
    for await (const chunk of stream) {
      sink.text += decoder.decode(chunk, { stream: true })
    }
    sink.text += decoder.decode()
  })().catch(() => {
    // A read torn off by kill() must not become an unhandled rejection. Losing
    // output can only fail an assertion here, never satisfy one.
  })
}

/**
 * A port the kernel just handed out, so the run does not collide with a server
 * an earlier boot leaked. `GUREN_STRICT_PORT=1` below turns a collision that
 * slips through the gap into a boot failure rather than a silent walk forward.
 */
async function freePort(): Promise<number> {
  const server = Bun.serve({ port: 0, hostname: RUNTIME_HOST, fetch: () => new Response('') })
  const { port } = server
  await server.stop(true)
  return port
}

function startApp(options: SessionDriverProbeOptions, driver: string, port: number): StartedApp {
  const sink = { text: '' }
  const proc = Bun.spawn({
    cmd: ['bun', 'bin/serve.ts'],
    cwd: options.appDir,
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      ...process.env,
      ...options.env,
      SESSION_DRIVER: driver,
      PORT: String(port),
      HOST: RUNTIME_HOST,
      // The banner carries the bound address this probe parses. Development
      // already implies it (the gate is `GUREN_DEV_BANNER !== '0'`); this pins
      // it should the banner ever become opt-in.
      GUREN_DEV_BANNER: '1',
      GUREN_STRICT_PORT: '1',
      ...DEVELOPMENT_ENV,
    },
  })
  const drains = [
    drain(proc.stdout as ReadableStream<Uint8Array>, sink),
    drain(proc.stderr as ReadableStream<Uint8Array>, sink),
  ]

  return {
    proc,
    output: () => sink.text,
    // Bounded: a stream torn off by kill(), or a child still writing, never ends.
    drained: async () => {
      await Promise.race([Promise.all(drains), Bun.sleep(DRAIN_SETTLE_MS)])
    },
    stop: async () => {
      proc.kill()
      // Awaited so the port is released before the next driver's boot claims it,
      // but bounded: stop() sits in every failure path, and the framework's
      // SIGTERM handling is the only thing that ends this wait.
      await Promise.race([proc.exited, Bun.sleep(STOP_TIMEOUT_MS)])
      if (proc.exitCode === null) {
        proc.kill('SIGKILL')
        await proc.exited
      }
    },
  }
}

/**
 * The last `:<digits>` on the banner's bound-address line, so an ANSI-coloured
 * banner parses the same. Newline-terminated lines only: this reads output the
 * child is still writing, and a chunk boundary inside the port digits would
 * otherwise parse `:4` out of `:4131` and fail against the wrong port.
 */
function boundPort(output: string): number | undefined {
  for (const line of output.split('\n').slice(0, -1)) {
    if (!line.includes('Bound address')) continue
    const ports = line.match(/:(\d+)/gu)
    const last = ports?.at(-1)
    if (last) return Number(last.slice(1))
  }
  return undefined
}

function hasExited(proc: Bun.Subprocess): boolean {
  return proc.exitCode !== null || proc.killed
}

/** Both callers wait for the same three outcomes; which one arrived is their verdict to make, not this one's. */
async function waitForBootOutcome(started: StartedApp): Promise<void> {
  const deadline = Date.now() + BOOT_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (hasExited(started.proc) || boundPort(started.output()) !== undefined) return
    await Bun.sleep(100)
  }
}

/**
 * Boot and wait for the app to *report* the port it bound, rather than assuming
 * the one it was handed: addressing the requested port is how a server leaked by
 * an earlier run silently answers for the app under test.
 */
async function bootApp(options: SessionDriverProbeOptions, driver: string): Promise<RunningApp> {
  const requested = await freePort()
  const started = startApp(options, driver, requested)

  // Catch, not finally: a `finally` would also run on the success path and kill
  // the app the caller is about to drive. Every throw below leaves a child bound
  // to a socket for the life of the job otherwise.
  try {
    await waitForBootOutcome(started)

    const port = boundPort(started.output())
    if (port !== undefined) {
      assert(
        port === requested,
        `SESSION_DRIVER=${driver}: the app bound port ${port} after being handed ${requested}. `
          + `GUREN_STRICT_PORT=1 should have failed the boot instead.\n${started.output()}`,
      )
      return { ...started, url: `http://${RUNTIME_HOST}:${port}` }
    }

    await started.drained()
    if (hasExited(started.proc)) {
      throw new Error(
        `SESSION_DRIVER=${driver}: the app exited before it reported a bound address.\n${started.output()}`,
      )
    }
    throw new Error(
      `SESSION_DRIVER=${driver}: no bound address within ${BOOT_TIMEOUT_MS / 1000}s.\n${started.output()}`,
    )
  } catch (error) {
    await started.stop()
    throw error
  }
}

/**
 * A driver name the app must refuse, asserted on the message rather than on the
 * exit code: a port collision, a missing migration and a bad APP_KEY all exit
 * non-zero too, and any of them would let this pass while proving nothing.
 * Never `await proc.exited` alone here — an app that wrongly accepts the name
 * serves happily, and the wait this check is *about* would hang forever.
 */
async function assertBootRefused(
  options: SessionDriverProbeOptions,
  driver: string,
  needle: string,
  guidance: string,
): Promise<string> {
  const started = startApp(options, driver, await freePort())
  try {
    await waitForBootOutcome(started)
    await started.drained()
    const output = started.output()
    assert(
      started.proc.exitCode !== null && started.proc.exitCode !== 0,
      `SESSION_DRIVER=${driver} did not fail the boot.\n${guidance}\n${output}`,
    )
    assert(
      output.includes(needle),
      `SESSION_DRIVER=${driver} failed the boot, but not for the reason under test: `
        + `the output never says "${needle}".\n${guidance}\n${output}`,
    )
    return output
  } finally {
    await started.stop()
  }
}

/**
 * The stores the app reports declaring, read out of the refusal message — the
 * app's own answer, so nothing here parses config/session.ts a second way.
 * Anchored on the *driver name*: Bun prints the throwing source line too, and
 * its `${defaultName} (declared: ${…})` template matches any looser pattern.
 */
function declaredStores(output: string, driver: string): string[] | undefined {
  const marker = `Session store not found: ${driver} (declared: `
  const start = output.indexOf(marker)
  if (start < 0) return undefined
  const end = output.indexOf(')', start + marker.length)
  if (end < 0) return undefined
  return output.slice(start + marker.length, end).split(',').map((name) => name.trim()).filter(Boolean)
}

/**
 * One request of the round-trip below. The status is checked before anything
 * reads the body: a 302 or a 500 arrives as a body that merely lacks the needle.
 * The jar rides along only once it holds a cookie, so the first request sends no
 * `Cookie` header at all.
 */
async function requestInSession(
  label: string,
  url: string,
  jar: CookieJar,
  expected: number,
  init: RequestInit = {},
): Promise<void> {
  const headers = new Headers(init.headers)
  const cookie = jar.header()
  if (cookie !== '') {
    headers.set('Cookie', cookie)
  }

  const response = await fetch(url, { redirect: 'manual', ...init, headers })
  const body = await response.text()
  jar.absorb(response)
  assert(
    response.status === expected,
    `${label}: expected HTTP ${expected}, got ${response.status}.\n${body.slice(0, 800)}`,
  )
}

/**
 * Register a user and read back a page only an authenticated session reaches.
 * `RegisterController.store()` regenerates the session and logs in, the one
 * flow in a scaffolded app that writes to the session store. Returns the
 * session cookie's length, taken at the same point for every driver; every
 * store's value is base64url, so the jar's decode leaves that length intact.
 */
async function authenticate(url: string, driver: string, email: string): Promise<number> {
  const jar = new CookieJar()

  await requestInSession(`SESSION_DRIVER=${driver}: GET /register`, `${url}/register`, jar, 200)

  const token = jar.get(XSRF_COOKIE)
  assert(
    token !== undefined,
    `SESSION_DRIVER=${driver}: GET /register set no ${XSRF_COOKIE} cookie, so the POST below cannot pass CSRF.`,
  )

  await requestInSession(`SESSION_DRIVER=${driver}: POST /register`, `${url}/register`, jar, 303, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-XSRF-TOKEN': token,
    },
    body: JSON.stringify({
      name: 'Session Probe',
      email,
      password: 'session-probe-secret',
      passwordConfirmation: 'session-probe-secret',
    }),
  })

  const session = jar.get(SESSION_COOKIE)
  assert(
    session !== undefined,
    `SESSION_DRIVER=${driver}: logging in set no ${SESSION_COOKIE} cookie, so no session was persisted.`,
  )

  await requestInSession(
    `SESSION_DRIVER=${driver}: GET /dashboard as the registered user`,
    `${url}/dashboard`,
    jar,
    200,
  )

  return session.length
}

/** The dev-mode SQLite file `config/database.ts` opens, which is what NODE_ENV=development above pins. */
async function developmentDatabaseFile(appDir: string): Promise<string> {
  const env = await readFile(join(appDir, '.env'), 'utf8')
  const url = /^DATABASE_URL=(.*)$/mu.exec(env)?.[1]?.trim() ?? './data/guren.db'
  assert(
    !url.includes('://'),
    `This probe reads the sessions table with bun:sqlite, but the app's DATABASE_URL is "${url}". `
      + 'Teach it that driver, or scaffold the smoke app on SQLite.',
  )
  return join(appDir, url)
}

function countSessionRows(databaseFile: string): number {
  const database = new Database(databaseFile, { readonly: true })
  try {
    const row = database.query('select count(*) as total from sessions').get() as { total: number }
    return row.total
  } finally {
    database.close()
  }
}

export async function assertSessionDrivers(options: SessionDriverProbeOptions): Promise<void> {
  const { appDir, cliBin, env, run } = options
  // Unique per run: /register refuses a second account on the same address, so a
  // fixed one turns a re-run against a kept smoke workspace into a 422.
  const runId = globalThis.crypto.randomUUID().slice(0, 8)

  // The development database, not the one `bun test` (and so `guren gate`) uses:
  // without this migration the `database` driver has no table to write to.
  await run(['bun', cliBin, 'db:migrate'], appDir, { ...env, ...DEVELOPMENT_ENV })
  const databaseFile = await developmentDatabaseFile(appDir)

  const refusal = await assertBootRefused(
    options,
    'not-a-real-driver',
    'Session store not found: not-a-real-driver',
    'An unknown store name must fail the boot, or every driver assertion below is vacuous. '
      + 'Either the app no longer reads SESSION_DRIVER (Bun loads .env without overriding the '
      + 'environment a parent passes, so a dead env var reads exactly like this), or an unknown '
      + 'name now falls back to some other store silently.',
  )

  const declared = declaredStores(refusal, 'not-a-real-driver')
  assert(declared !== undefined, `The refusal did not name the declared stores:\n${refusal}`)
  const covered = Object.keys(EXPECTED_SESSION_ROWS)
  // Scoped to *declared* stores (`SessionManager.getStoreNames()`, its
  // `configs` keys), never the driver registry: a fix that let `resolve()` fall
  // back to a registered driver with no `stores` entry would keep this green
  // while `cookie` stayed unexercised.
  const uncovered = declared.filter((name) => !covered.includes(name))
  assert(
    uncovered.length === 0,
    `config/session.ts now declares ${uncovered.join(', ')}, which this probe never exercises. `
      + "Give each one a row expectation in EXPECTED_SESSION_ROWS ('written' if its store writes to "
      + "the sessions table, 'none' otherwise).",
  )

  const missing = REQUIRED_SESSION_STORES.filter((name) => !declared.includes(name))
  assert(
    missing.length === 0,
    `The app no longer declares ${missing.join(', ')}. The loop below exercises the stores the app `
      + 'declares, so a dropped store would leave this gate green while proving less than it did.',
  )

  // The app's own order, so the log reads like its declaration.
  const exercised = declared.filter((name) => name in EXPECTED_SESSION_ROWS)
  const unadopted = Object.keys(EXPECTED_SESSION_ROWS).filter((name) => !declared.includes(name))
  for (const name of unadopted) {
    console.log(`  skipped: SESSION_DRIVER=${name} — this scaffold declares no such store, so it cannot boot one`)
  }

  const cookieLengths = new Map<string, number>()
  for (const driver of exercised) {
    const expectation = EXPECTED_SESSION_ROWS[driver]
    const before = countSessionRows(databaseFile)
    const app = await bootApp(options, driver)
    try {
      cookieLengths.set(driver, await authenticate(app.url, driver, `session-probe-${driver}-${runId}@example.com`))
    } catch (error) {
      await app.drained()
      console.error(`\n--- server log (SESSION_DRIVER=${driver}) ---\n${app.output()}`)
      throw error
    } finally {
      await app.stop()
    }

    const written = countSessionRows(databaseFile) - before
    if (expectation === 'written') {
      assert(
        written > 0,
        `SESSION_DRIVER=${driver} authenticated without writing a row to the sessions table. `
          + 'The name resolved to some other store, so the driver was not honoured.',
      )
    } else {
      assert(
        written === 0,
        `SESSION_DRIVER=${driver} wrote ${written} row(s) to the sessions table. `
          + 'The name resolved to the database store instead of the one it names.',
      )
    }
    console.log(`  OK: SESSION_DRIVER=${driver} — session round-trip, ${written} sessions row(s) written`)
  }

  // Relative, so no constant here can go stale: both lengths come from the same
  // app and the same round-trip in this run.
  const carried = cookieLengths.get('cookie')
  const identifier = cookieLengths.get('memory')
  const compared = carried !== undefined && identifier !== undefined
  if (compared) {
    assert(
      carried >= identifier * COOKIE_STATE_LENGTH_FACTOR,
      `SESSION_DRIVER=cookie set a ${carried}-character session cookie against SESSION_DRIVER=memory's `
        + `${identifier}, short of the ${COOKIE_STATE_LENGTH_FACTOR}x this probe requires. Every keyed store `
        + 'signs the same UUID, so a server-side fallback matches memory exactly, while a session carried in '
        + 'the cookie floors near 1.6x it — the threshold sits below that floor only to leave room for a '
        + 'session holding less. So `cookie` resolved to a server-side store.',
    )
    console.log(`  OK: SESSION_DRIVER=cookie set a ${carried}-character session cookie against memory's ${identifier}`)
  } else {
    console.log('  skipped: the cookie-length comparison needs cookie and memory both exercised in one run')
  }

  console.log([
    '',
    'Session driver probe passed (RFC 0020 Part 5).',
    `  declared stores      ${declared.join(', ')}`,
    '  not-a-real-driver    refused at boot, so a silent fallback cannot make the rows below vacuous',
    ...exercised.map((driver) =>
      `  ${driver.padEnd(20)} authenticated; the sessions table gained `
      + (EXPECTED_SESSION_ROWS[driver] === 'written' ? 'a row' : 'none, so the name is not the database store')),
    ...(compared
      ? [
        `  cookie vs memory     the cookie driver's session cookie carried ${carried} characters against`,
        `                       memory's ${identifier}, so cookie keeps the session state in the cookie while`,
        '                       memory keeps it server-side: two no-row passes that are not the same store',
      ]
      : [
        '  cookie vs memory     NOT compared: both have to run in one job. Without it a no-row pass proves',
        '                       only that the name is not the database store, never which store it is',
      ]),
    '  still unproven       that the cookie payload is encrypted, and that an oversize session is refused',
    '                       rather than emitted: neither is visible from outside one round-trip',
    ...unadopted.map((name) =>
      `  ${name.padEnd(20)} NOT exercised: this scaffold declares no ${name} store, so `
      + `SESSION_DRIVER=${name} cannot boot a scaffolded app`),
  ].join('\n'))
}
