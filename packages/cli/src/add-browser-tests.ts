/**
 * `guren add browser-tests` (RFC 0033 §6): Playwright set up to start the app through
 * `guren browser:serve`, and, where the app signs in with a password, a setup project and a
 * guarded seeder for one browser account. These files are written once; the specs under
 * `tests/browser/generated/` are `guren browser:map`'s, which this runs once at the end.
 */

import { writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { consola } from 'consola'

import { assertNotApiOnly } from './app-surface'
import { loadBrowserMap, runBrowserMap } from './browser-map-files'
import type { BrowserMap } from './browser-map'
import { BROWSER_SEEDER_FILE, BROWSER_TESTS_CONFIG, BROWSER_TESTS_SETUP, buildBrowserSeeder, type BrowserSeederColumns } from './browser-specs'
import { cliDependencyRange } from './cli-manifest'
import { CliError } from './cli-error'
import { appDependsOn, readIfExists } from './discovery'
import { appendEnvEntry } from './env-registrar'
import { ensureGitignoreEntry } from './plugin-scaffold'
import { scaffoldTemplateFile } from './scaffold-templates'
import { findDeclaredTable, type SchemaTable } from './schema-parser'
import { assertCwdUnsupported, runCommand, writeScaffoldFiles, type ScaffoldFileEntry, type WriterOptions } from './utils'

const PLAYWRIGHT_PACKAGE = '@playwright/test'
export const BROWSER_TEST_SCRIPT = { name: 'test:browser', command: `playwright test -c ${BROWSER_TESTS_CONFIG}` } as const
const GITIGNORE_ENTRIES = ['test-results/', 'playwright-report/', 'tests/browser/.auth/'] as const

export interface AddBrowserTestsOptions extends WriterOptions {
  /** Run `bun add -d` for Playwright; false prints the command instead. */
  install?: boolean
  /** The test seam: how the browser map is read before anything is written. */
  loadMap?: (cwd: string) => Promise<BrowserMap>
}

export interface AddBrowserTestsResult {
  /** Files written once, by this run. */
  created: string[]
  /** What the closing `browser:map` run wrote and removed, app-relative. */
  mapped: { changed: string[]; removed: string[]; held?: string }
  /** A setup project signs in as the seeded browser account. */
  signIn: boolean
  map: BrowserMap
  /** False when config/database.ts never seeds on boot, so `browser:serve` never writes the browser account. */
  seedsOnBoot: boolean
}

/** Positive evidence only: a root `users` table with a password column, and a password login route. */
function passwordSignIn(users: SchemaTable | undefined, map: BrowserMap): BrowserSeederColumns | undefined {
  const columns = new Set(users?.columns.map((column) => column.name))
  if (!columns.has('email') || !columns.has('passwordHash')) return undefined
  const routes = [...map.features.flatMap((feature) => feature.routes), ...map.unassigned]
  if (!routes.some((route) => route.method === 'POST' && route.path === '/login')) return undefined
  return { name: columns.has('name'), emailVerifiedAt: columns.has('emailVerifiedAt') }
}

interface Manifest {
  scripts?: Record<string, string>
  [key: string]: unknown
}

/** The script runs this blueprint's config; one of the same name running anything else is not taken over. */
async function readManifest(cwd: string, force: boolean): Promise<Manifest | undefined> {
  const raw = await readIfExists(cwd, 'package.json')
  if (raw === null) return undefined
  const manifest = JSON.parse(raw) as Manifest
  const existing = manifest.scripts?.[BROWSER_TEST_SCRIPT.name]
  if (existing !== undefined && existing !== BROWSER_TEST_SCRIPT.command && !force) {
    throw new CliError(`package.json already has a ${BROWSER_TEST_SCRIPT.name} script (${existing}), which would not run these specs. Rename it, or pass --force to replace it with "${BROWSER_TEST_SCRIPT.command}". Nothing was written.`)
  }
  return manifest
}

async function installPlaywright(cwd: string, install: boolean): Promise<void> {
  // An unreadable manifest answers null; installing then is what the user asked for.
  if ((await appDependsOn(cwd, PLAYWRIGHT_PACKAGE)) === true) return
  const spec = `${PLAYWRIGHT_PACKAGE}@${cliDependencyRange('devDependencies', PLAYWRIGHT_PACKAGE)}`
  if (install) await runCommand('bun', ['add', '-d', spec], { cwd })
  else consola.info(`Run: bun add -d ${spec}`)
}

export async function addBrowserTests(options: AddBrowserTestsOptions = {}): Promise<AddBrowserTestsResult> {
  assertCwdUnsupported(options, 'guren add browser-tests')
  const cwd = process.cwd()
  await assertNotApiOnly(cwd, {
    does: 'guren add browser-tests drives the Inertia pages of the app in a browser',
    instead: 'Test its routes over HTTP with TestApp from @guren/testing',
  })

  // Everything is read before the first write, so a refusal or a graph that will not load leaves the app untouched.
  const [map, users, manifest, database] = await Promise.all([
    (options.loadMap ?? loadBrowserMap)(cwd),
    findDeclaredTable(cwd, 'users'),
    readManifest(cwd, options.force === true),
    readIfExists(cwd, 'config/database.ts'),
  ])
  const account = passwordSignIn(users, map)
  // The closing browser:map run, written nowhere: its refusals (a slug two plans share, a spec of
  // the author's at a generated path, broken markers) come before anything else is written.
  await runBrowserMap({ cwd, write: false, map, specs: { signIn: account !== undefined } })

  const files: ScaffoldFileEntry[] = [
    scaffoldTemplateFile('browser-tests', BROWSER_TESTS_CONFIG),
    scaffoldTemplateFile('browser-tests', 'tests/browser/support.ts'),
    ...(account && users
      ? [scaffoldTemplateFile('browser-tests', BROWSER_TESTS_SETUP), { path: BROWSER_SEEDER_FILE, contents: buildBrowserSeeder(users.dialect, account) }]
      : []),
  ]
  const created = await writeScaffoldFiles(files, { force: options.force, overwritten: options.overwritten, skipExisting: true })

  if (manifest) {
    manifest.scripts = { ...manifest.scripts, [BROWSER_TEST_SCRIPT.name]: BROWSER_TEST_SCRIPT.command }
    await writeFile(resolve(cwd, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  } else {
    consola.warn(`package.json not found; add "${BROWSER_TEST_SCRIPT.name}": "${BROWSER_TEST_SCRIPT.command}" to its scripts by hand.`)
  }
  for (const entry of GITIGNORE_ENTRIES) await ensureGitignoreEntry(entry)
  if (account) {
    await appendEnvEntry(
      'BROWSER_TEST_PASSWORD',
      '\n# The browser account\'s password: db/seeders/browser-account.ts seeds it while `guren browser:serve` runs the app, and the Playwright setup project signs in with it.\nBROWSER_TEST_PASSWORD=\n',
      { declare: { secret: true } },
    )
  }
  await installPlaywright(cwd, options.install ?? true)

  const mapped = await runBrowserMap({ cwd, write: true, map })
  return {
    created,
    mapped: { changed: mapped.changed, removed: mapped.removed, ...(mapped.specsHeld ? { held: mapped.specsHeld } : {}) },
    signIn: account !== undefined,
    map,
    seedsOnBoot: database?.includes('seedOnBoot') === true,
  }
}
