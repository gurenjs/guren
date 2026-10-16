/**
 * `guren add browser-tests` (RFC 0033 §6): Playwright set up to start the app through
 * `guren browser:serve`, specs generated from the browser map, and, where the app signs in
 * with a password, a setup project and a guarded seeder for one browser account. The
 * hand-kept files are written once; the generated specs are rewritten on every run.
 */

import { readdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { consola } from 'consola'

import { assertNotApiOnly } from './app-surface'
import { loadApplicationGraph } from './application-graph-load'
import { approvedPlans } from './browser-map-files'
import { buildBrowserMap, type BrowserMap } from './browser-map'
import {
  BROWSER_SEEDER_FILE, buildBrowserSeeder, buildPlanSpecs, buildSmokeSpec, GENERATED_HEADER, GENERATED_SPECS_DIR, SMOKE_SPEC_FILE,
  type GeneratedSpec,
} from './browser-specs'
import { cliDependencyRange } from './cli-manifest'
import { appDependsOn, readIfExists } from './discovery'
import { appendEnvEntry } from './env-registrar'
import { readSchemaDialect } from './patch-helpers'
import { ensureGitignoreEntry } from './plugin-scaffold'
import { scaffoldTemplateFile } from './scaffold-templates'
import { parseSchemaTables } from './schema-parser'
import { assertCwdUnsupported, runCommand, writeScaffoldFiles, type ScaffoldFileEntry, type WriterOptions } from './utils'

const PLAYWRIGHT_PACKAGE = '@playwright/test'
export const BROWSER_TEST_SCRIPT = { name: 'test:browser', command: 'playwright test' } as const
const GITIGNORE_ENTRIES = ['test-results/', 'playwright-report/', 'tests/browser/.auth/'] as const

export interface AddBrowserTestsOptions extends WriterOptions {
  /** Run `bun add -d` for Playwright; false prints the command instead. */
  install?: boolean
  /** The test seam: how the browser map is read, by default from the introspected app's graph. */
  loadMap?: (cwd: string) => Promise<BrowserMap>
}

async function loadBrowserMap(cwd: string): Promise<BrowserMap> {
  const [graph, { plans, unreadable }] = await Promise.all([loadApplicationGraph({ cwd, introspect: true }), approvedPlans(cwd)])
  return buildBrowserMap(graph, plans, unreadable)
}

export interface AddBrowserTestsResult {
  /** Hand-kept files written by this run. */
  created: string[]
  /** Generated specs, rewritten by every run. */
  generated: string[]
  /** Generated plan specs no approved plan produces any more; reported, never deleted. */
  orphans: string[]
  /** A setup project signs in as the seeded browser account. */
  signIn: boolean
  map: BrowserMap
}

/** Positive evidence only: `make:auth`'s users table with a password column, and a password login route. */
async function passwordSignIn(cwd: string, map: BrowserMap): Promise<{ name: boolean; emailVerifiedAt: boolean } | undefined> {
  const users = (await parseSchemaTables(cwd)).find((table) => table.module === null && table.identifier === 'users')
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

async function addScript(cwd: string): Promise<void> {
  const raw = await readIfExists(cwd, 'package.json')
  if (raw === null) {
    consola.warn(`package.json not found; add "${BROWSER_TEST_SCRIPT.name}": "${BROWSER_TEST_SCRIPT.command}" to its scripts by hand.`)
    return
  }
  const manifest = JSON.parse(raw) as Manifest
  if (manifest.scripts?.[BROWSER_TEST_SCRIPT.name] !== undefined) return
  manifest.scripts = { ...manifest.scripts, [BROWSER_TEST_SCRIPT.name]: BROWSER_TEST_SCRIPT.command }
  await writeFile(resolve(cwd, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  consola.success(`Added the ${BROWSER_TEST_SCRIPT.name} script`)
}

async function installPlaywright(cwd: string, install: boolean): Promise<void> {
  // An unreadable manifest answers null; installing then is what the user asked for.
  if ((await appDependsOn(cwd, PLAYWRIGHT_PACKAGE)) === true) return
  const spec = `${PLAYWRIGHT_PACKAGE}@${cliDependencyRange('devDependencies', PLAYWRIGHT_PACKAGE)}`
  if (install) await runCommand('bun', ['add', '-d', spec], { cwd })
  else consola.info(`Run: bun add -d ${spec}`)
}

/** Generated plan specs on disk that this run did not produce and that still carry the generated header. */
async function orphanSpecs(cwd: string, written: ReadonlySet<string>): Promise<string[]> {
  const dir = `${GENERATED_SPECS_DIR}/plans`
  let names: string[]
  try {
    names = await readdir(join(cwd, dir))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  const orphans: string[] = []
  for (const name of names.filter((entry) => entry.endsWith('.browser.ts')).sort()) {
    const file = `${dir}/${name}`
    if (written.has(file)) continue
    if ((await readFile(join(cwd, file), 'utf8')).startsWith(GENERATED_HEADER)) orphans.push(file)
  }
  return orphans
}

export async function addBrowserTests(options: AddBrowserTestsOptions = {}): Promise<AddBrowserTestsResult> {
  assertCwdUnsupported(options, 'guren add browser-tests')
  const cwd = process.cwd()
  await assertNotApiOnly(cwd, {
    does: 'guren add browser-tests drives the Inertia pages of the app in a browser',
    instead: 'Test its routes over HTTP with TestApp from @guren/testing',
  })

  // Read before anything is written, so an app whose graph cannot be loaded is left untouched.
  const map = await (options.loadMap ?? loadBrowserMap)(cwd)
  const account = await passwordSignIn(cwd, map)
  const signIn = account !== undefined

  const handKept: ScaffoldFileEntry[] = [
    scaffoldTemplateFile('browser-tests', 'playwright.config.ts'),
    scaffoldTemplateFile('browser-tests', 'tests/browser/support.ts'),
    ...(account
      ? [
          scaffoldTemplateFile('browser-tests', 'tests/browser/auth.setup.ts'),
          { path: BROWSER_SEEDER_FILE, contents: buildBrowserSeeder(await readSchemaDialect(cwd), account) },
        ]
      : []),
  ]
  const created = await writeScaffoldFiles(handKept, { force: options.force, overwritten: options.overwritten, skipExisting: true })

  const specs: GeneratedSpec[] = [{ path: SMOKE_SPEC_FILE, contents: buildSmokeSpec(map, { signIn }) }, ...buildPlanSpecs(map, { signIn })]
  const generated = await writeScaffoldFiles(specs, { force: true, overwritten: options.overwritten })
  const orphans = await orphanSpecs(cwd, new Set(specs.map((entry) => entry.path)))

  await addScript(cwd)
  for (const entry of GITIGNORE_ENTRIES) await ensureGitignoreEntry(entry)
  if (signIn) {
    await appendEnvEntry(
      'BROWSER_TEST_PASSWORD',
      '\n# The browser account\'s password: db/seeders/browser-account.ts seeds it while `guren browser:serve` runs the app, and the Playwright setup project signs in with it.\nBROWSER_TEST_PASSWORD=\n',
    )
  }
  await installPlaywright(cwd, options.install ?? true)
  return { created, generated, orphans, signIn, map }
}
