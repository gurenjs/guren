/**
 * `guren add browser-tests` (RFC 0033 §6): Playwright set up to start the app through
 * `guren browser:serve`, and, where the app signs in with a password, a setup project and a
 * guarded seeder for one browser account. These files are written once; the specs under
 * `tests/browser/generated/` are `guren browser:map`'s, which this runs once at the end.
 * `--behaviours --agent` (§13.4) adds the e2e runner's config, sign-in setup and `given.ts`
 * the same way, and `browser:map` then keeps `tests/browser/behaviours/generated/` too.
 */

import { writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { consola } from 'consola'

import { readAppLocale } from './app-locale'
import { assertNotApiOnly } from './app-surface'
import { BEHAVIOUR_PACKAGES, BEHAVIOURS_CONFIG, BEHAVIOURS_GIVEN_FILE, BEHAVIOURS_SETUP } from './browser-behaviour-specs'
import { loadBrowserMap, runBrowserMap } from './browser-map-files'
import type { ApprovedPlanInput, BrowserMap } from './browser-map'
import {
  A11Y_OPTIONS_FILE, AXE_PACKAGE, BROWSER_SEEDER_FILE, BROWSER_TESTS_CONFIG, BROWSER_TESTS_SETUP, buildBrowserSeeder, type BrowserSeederColumns,
} from './browser-specs'
import { cliDependencyRange } from './cli-manifest'
import { CliError } from './cli-error'
import { appDependsOn, readIfExists } from './discovery'
import { appendEnvEntry } from './env-registrar'
import { ensureGitignoreEntry } from './plugin-scaffold'
import { scaffoldTemplateFile } from './scaffold-templates'
import { quoteString } from './schema-columns'
import { findDeclaredTable, type SchemaTable } from './schema-parser'
import { assertCwdUnsupported, runCommand, writeScaffoldFiles, type ScaffoldFileEntry, type WriterOptions } from './utils'

const PLAYWRIGHT_PACKAGE = '@playwright/test'
// Installed at the ranges package.json declares; axe's is a tilde, since a new minor adds rules.
const DEV_PACKAGES = [PLAYWRIGHT_PACKAGE, AXE_PACKAGE] as const
export const BROWSER_TEST_SCRIPT = { name: 'test:browser', command: `playwright test -c ${BROWSER_TESTS_CONFIG}` } as const
const GITIGNORE_ENTRIES = ['test-results/', 'playwright-report/', 'tests/browser/.auth/'] as const

/** `--agent` values (RFC 0033 §13.4): whose login runs the steps. `codex` refuses until §13.9 measures it. */
export const BEHAVIOUR_AGENTS = ['claude-code', 'codex'] as const
export type BehaviourAgent = (typeof BEHAVIOUR_AGENTS)[number]
/** Installed at the exact versions package.json declares, the copies the config template is typechecked against. */
export const BEHAVIOUR_DEV_PACKAGES = [...BEHAVIOUR_PACKAGES, '@e2e-dev/acp'] as const
/** The adapter the runner starts Claude Code through. Nothing here imports it, so its range has no manifest entry to come from. */
export const CLAUDE_CODE_ADAPTER = { name: '@agentclientprotocol/claude-agent-acp', range: '^0.107.0' } as const
const BEHAVIOURS_RUN = `E2E_TELEMETRY_DISABLED=1 bunx --bun e2e run --config ${BEHAVIOURS_CONFIG}`
/** `--bun`, so the suite needs no Node; `--strict-cache` fails a stale recording with no model call. */
export const BEHAVIOUR_SCRIPTS = [
  { name: 'test:behaviours', command: BEHAVIOURS_RUN },
  { name: 'test:behaviours:ci', command: `${BEHAVIOURS_RUN} --strict-cache` },
] as const
// `.e2e/*`, not `.e2e/`: git never looks inside an ignored directory, so the recordings could not be re-included.
const BEHAVIOUR_GITIGNORE_ENTRIES = ['.e2e/*', '!.e2e/cache/'] as const
const IGNORES_E2E_DIRECTORY = /^\/?\.e2e\/?$/u

export interface AddBrowserTestsOptions extends WriterOptions {
  /** Run `bun add -d` for the packages the app lacks; false prints the command instead. */
  install?: boolean
  /** Also set up the behaviour specs the e2e runner performs (RFC 0033 §13.4); needs `agent`. */
  behaviours?: boolean
  /** The `--agent` value as typed; checked against {@link BEHAVIOUR_AGENTS} before anything is read. */
  agent?: string
  /** The test seam: how the browser map is read before anything is written. */
  loadMap?: (cwd: string) => Promise<BrowserMap>
  /** The test seam: the approved plans `loadMap`'s map was built from. Omitted, `browser:map` reads them from disk. */
  plans?: readonly ApprovedPlanInput[]
}

export interface AddBrowserTestsResult {
  /** Files written once, by this run. */
  created: string[]
  /** What the closing `browser:map` run wrote and removed, app-relative. */
  mapped: { changed: string[]; removed: string[]; held?: string; accessibilityOff?: string; behavioursOff?: string; unlabelledInputs?: string[] }
  /** The agent the behaviour specs were set up for, when `--behaviours` was passed. */
  behaviours?: BehaviourAgent
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

/** The locale line of both config templates; `guren add browser-tests` writes the app's default locale there. */
export const CONFIG_LOCALE_LINE = "const LOCALE = 'en'\n"

/**
 * The config with the app's default locale (RFC 0036 §5). An app whose `createApp({ i18n })` this cannot
 * read keeps `en`, the locale the server falls back to without `i18n`; a plan spec names a mismatch.
 */
export function pinConfigLocale(config: ScaffoldFileEntry, locale: string | undefined): ScaffoldFileEntry {
  if (config.contents.split(CONFIG_LOCALE_LINE).length !== 2) throw new Error(`${config.path} has no single ${CONFIG_LOCALE_LINE.trim()} line to write the app's locale on.`)
  if (locale === undefined) return config
  return { ...config, contents: config.contents.replace(CONFIG_LOCALE_LINE, () => `const LOCALE = ${quoteString(locale)}\n`) }
}

interface Manifest {
  scripts?: Record<string, string>
  [key: string]: unknown
}

type Script = { readonly name: string; readonly command: string }

/** Each script runs this blueprint's config; one of the same name running anything else is not taken over. */
async function readManifest(cwd: string, scripts: readonly Script[], force: boolean): Promise<Manifest | undefined> {
  const raw = await readIfExists(cwd, 'package.json')
  if (raw === null) return undefined
  const manifest = JSON.parse(raw) as Manifest
  for (const script of scripts) {
    const existing = manifest.scripts?.[script.name]
    if (existing !== undefined && existing !== script.command && !force) {
      throw new CliError(`package.json already has a ${script.name} script (${existing}), which would not run these specs. Rename it, or pass --force to replace it with "${script.command}"; --force also rewrites the configs, setups, support files and seeder this command wrote once, edits included. Nothing was written.`)
    }
  }
  return manifest
}

/**
 * `--behaviours` and `--agent` name each other: whose login runs the steps is the person's choice,
 * so there is no default, and `--agent` alone would set up nothing.
 */
export function behaviourAgent(options: Pick<AddBrowserTestsOptions, 'behaviours' | 'agent'>): BehaviourAgent | undefined {
  const choices = BEHAVIOUR_AGENTS.map((agent) => `--agent ${agent}`).join(' or ')
  if (!options.behaviours) {
    if (options.agent !== undefined) throw new CliError(`--agent chooses whose login runs the behaviour specs, so it goes with --behaviours. Nothing was written.`)
    return undefined
  }
  if (options.agent === undefined) {
    throw new CliError(`--behaviours needs ${choices}: the steps run under that agent's login on this machine, and there is no default. Nothing was written.`)
  }
  const agent = BEHAVIOUR_AGENTS.find((name) => name === options.agent)
  if (agent === undefined) throw new CliError(`--agent ${options.agent} names no agent the behaviour specs run on; pass ${choices}. Nothing was written.`)
  if (agent === 'codex') {
    throw new CliError('--agent codex is not available yet: the generated specs have been measured on Claude Code only (RFC 0033 §13.9). Pass --agent claude-code. Nothing was written.')
  }
  return agent
}

/** Only what the manifest does not declare, so a rerun on an app that has Playwright adds axe alone. */
async function installDevPackages(cwd: string, install: boolean, behaviours: boolean): Promise<void> {
  const wanted = [
    ...DEV_PACKAGES.map((name) => ({ name, range: cliDependencyRange('devDependencies', name) })),
    ...(behaviours ? [...BEHAVIOUR_DEV_PACKAGES.map((name) => ({ name, range: cliDependencyRange('devDependencies', name) })), CLAUDE_CODE_ADAPTER] : []),
  ]
  const missing: string[] = []
  for (const { name, range } of wanted) {
    // An unreadable manifest answers null; installing then is what the user asked for.
    if ((await appDependsOn(cwd, name)) !== true) missing.push(`${name}@${range}`)
  }
  if (missing.length === 0) return
  if (install) await runCommand('bun', ['add', '-d', ...missing], { cwd })
  else consola.info(`Run: bun add -d ${missing.join(' ')}`)
}

export async function addBrowserTests(options: AddBrowserTestsOptions = {}): Promise<AddBrowserTestsResult> {
  assertCwdUnsupported(options, 'guren add browser-tests')
  const agent = behaviourAgent(options)
  const scripts: Script[] = [BROWSER_TEST_SCRIPT, ...(agent ? BEHAVIOUR_SCRIPTS : [])]
  const cwd = process.cwd()
  await assertNotApiOnly(cwd, {
    does: 'guren add browser-tests drives the Inertia pages of the app in a browser',
    instead: 'Test its routes over HTTP with TestApp from @guren/testing',
  })

  // Everything is read before the first write, so a refusal or a graph that will not load leaves the app untouched.
  const [map, users, manifest, database, locale] = await Promise.all([
    (options.loadMap ?? loadBrowserMap)(cwd),
    findDeclaredTable(cwd, 'users'),
    readManifest(cwd, scripts, options.force === true),
    readIfExists(cwd, 'config/database.ts'),
    readAppLocale(cwd),
  ])
  const account = passwordSignIn(users, map)
  // The closing browser:map run, written nowhere: its refusals (a slug two plans share, a spec of
  // the author's at a generated path, broken markers) come before anything else is written.
  await runBrowserMap({
    cwd, write: false, map,
    ...(options.plans ? { plans: options.plans } : {}),
    specs: { signIn: account !== undefined, accessibility: true },
    ...(agent ? { behaviours: { signIn: account !== undefined } } : {}),
  })

  const pinned = locale.kind === 'locale' ? locale.locale : undefined
  const files: ScaffoldFileEntry[] = [
    pinConfigLocale(scaffoldTemplateFile('browser-tests', BROWSER_TESTS_CONFIG), pinned),
    scaffoldTemplateFile('browser-tests', 'tests/browser/support.ts'),
    scaffoldTemplateFile('browser-tests', A11Y_OPTIONS_FILE),
    ...(account && users
      ? [scaffoldTemplateFile('browser-tests', BROWSER_TESTS_SETUP), { path: BROWSER_SEEDER_FILE, contents: buildBrowserSeeder(users.dialect, account) }]
      : []),
    ...(agent
      ? [pinConfigLocale(scaffoldTemplateFile('browser-tests', BEHAVIOURS_CONFIG), pinned), ...(account ? [scaffoldTemplateFile('browser-tests', BEHAVIOURS_SETUP)] : [])]
      : []),
  ]
  const created = await writeScaffoldFiles(files, { force: options.force, overwritten: options.overwritten, skipExisting: true })
  // The entries in given.ts are the author's work, so --force never replaces it.
  if (agent && (await readIfExists(cwd, BEHAVIOURS_GIVEN_FILE)) === null) {
    created.push(...await writeScaffoldFiles([scaffoldTemplateFile('browser-tests', BEHAVIOURS_GIVEN_FILE)]))
  }
  const unpinned = [BROWSER_TESTS_CONFIG, BEHAVIOURS_CONFIG].filter((config) => created.includes(resolve(cwd, config)))
  if (locale.kind === 'unknown' && unpinned.length > 0) {
    consola.warn(`The app's default locale could not be read from createApp({ i18n }), so ${unpinned.join(' and ')} send${unpinned.length > 1 ? '' : 's'} en. If the app falls back to another locale, set LOCALE there; the plan specs fail until it matches.`)
  }

  if (manifest) {
    manifest.scripts = { ...manifest.scripts, ...Object.fromEntries(scripts.map((script) => [script.name, script.command])) }
    await writeFile(resolve(cwd, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  } else {
    consola.warn(`package.json not found; add ${scripts.map((script) => `"${script.name}": "${script.command}"`).join(' and ')} to its scripts by hand.`)
  }
  for (const entry of [...GITIGNORE_ENTRIES, ...(agent ? BEHAVIOUR_GITIGNORE_ENTRIES : [])]) await ensureGitignoreEntry(entry)
  const ignoredWhole = agent ? (await readIfExists(cwd, '.gitignore'))?.split(/\r?\n/u).find((line) => IGNORES_E2E_DIRECTORY.test(line.trim())) : undefined
  if (ignoredWhole !== undefined) {
    consola.warn(`.gitignore has the line ${ignoredWhole.trim()}, which ignores the whole directory, so git never reaches .e2e/cache/ and no recording can be committed. Remove that line; this command added .e2e/* and !.e2e/cache/ in its place.`)
  }
  if (account) {
    await appendEnvEntry(
      'BROWSER_TEST_PASSWORD',
      '\n# The browser account\'s password: db/seeders/browser-account.ts seeds it while `guren browser:serve` runs the app, and the Playwright setup project signs in with it.\nBROWSER_TEST_PASSWORD=\n',
      { declare: { secret: true } },
    )
  }
  await installDevPackages(cwd, options.install ?? true, agent !== undefined)

  const mapped = await runBrowserMap({ cwd, write: true, map, ...(options.plans ? { plans: options.plans } : {}) })
  return {
    created,
    mapped: {
      changed: mapped.changed, removed: mapped.removed,
      ...(mapped.specsHeld ? { held: mapped.specsHeld } : {}),
      ...(mapped.accessibilityOff ? { accessibilityOff: mapped.accessibilityOff } : {}),
      ...(mapped.behavioursOff ? { behavioursOff: mapped.behavioursOff } : {}),
      ...(mapped.unlabelledInputs ? { unlabelledInputs: mapped.unlabelledInputs } : {}),
    },
    ...(agent ? { behaviours: agent } : {}),
    signIn: account !== undefined,
    map,
    seedsOnBoot: database?.includes('seedOnBoot') === true,
  }
}
