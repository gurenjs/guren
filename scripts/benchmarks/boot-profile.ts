/**
 * Splits the time from process start to "listening" into the three phases a
 * framework can act on, for one app:
 *
 *   import  — loading and evaluating the module graph (app + providers + deps)
 *   boot    — app.boot(): provider registration, DB connect, migration check
 *   listen  — binding the socket
 *
 * Printed as a single line so a harness can scrape it without a pipe:
 *
 *   BOOT_PROFILE import=93.1 boot=37.0 listen=3.7 total=133.8
 *
 * Usage, from the app's own directory so its `@guren/*` resolve the way the
 * app resolves them:
 *
 *   GUREN_BENCH_APP=./src/main.js bun ../../scripts/benchmarks/boot-profile.ts
 *
 * WHAT THIS DOES NOT MEASURE. It loads the module graph the way `bun run`
 * does — file by file, nothing bundled. Every serverless target bundles
 * instead (`@guren/plugin-vercel` and `@guren/plugin-lambda` both call
 * `Bun.build`), and the two paths respond to different things. A change that
 * only lets a *bundler* drop code — `sideEffects`, moving an import behind a
 * branch a `--define` settles — is invisible here by construction, and reading
 * a flat result as "no improvement" is the mistake this paragraph exists to
 * prevent. Measure those by bundling with the deploy plugin's own options and
 * timing the bundle's cold start.
 *
 * The app needs a reachable database and whatever env it validates at boot
 * (`APP_KEY`, `DATABASE_URL`). Set `GUREN_STRICT_PORT=1` so a busy port fails
 * rather than being silently walked past, and `GUREN_QUIET_DUPLICATE_ORM=1`
 * when running inside this monorepo, where src and dist copies coexist by
 * design and the warning would otherwise land mid-measurement.
 */
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

// Resolved against the app's directory, not this file's. A bare relative
// specifier in a dynamic import resolves relative to the *module doing the
// importing*, which would look for the app under scripts/benchmarks/.
const entry = pathToFileURL(resolve(process.cwd(), process.env.GUREN_BENCH_APP ?? './src/main.js')).href

const t0 = performance.now()

const { default: app, ready } = await import(entry)
const tImport = performance.now()

await ready
const tBoot = performance.now()

// `PORT=0` means "any free port", so this tests for a number, not truthiness —
// `|| 3333` would turn the one value a concurrent harness relies on into a
// fixed port every run then collides on.
const parsedPort = Number.parseInt(process.env.PORT ?? '', 10)
const port = Number.isInteger(parsedPort) ? parsedPort : 3333
await app.listen({ port, hostname: process.env.HOST ?? '127.0.0.1' })
const tListen = performance.now()

const r = (n: number) => Math.round(n * 10) / 10
console.log(
  `BOOT_PROFILE import=${r(tImport - t0)} boot=${r(tBoot - tImport)} listen=${r(
    tListen - tBoot,
  )} total=${r(tListen - t0)}`,
)

process.exit(0)
