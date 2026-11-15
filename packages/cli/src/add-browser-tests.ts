/**
 * `guren add browser-tests` (RFC 0033 §6): Playwright set up to start the app through
 * `guren browser:serve`, and, where the app signs in with a password, a setup project and a
 * guarded seeder for one browser account. These files are written once; the specs under
 * `tests/browser/generated/` are `guren browser:map`'s, which this runs once at the end.
 * `--behaviours --agent` (§13.4) adds the e2e runner's config, sign-in setup and `given.ts`
 * the same way, and `browser:map` then keeps `tests/browser/behaviours/generated/` too.
 */

import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { consola } from 'consola'

import { readAppLocale } from './app-locale'
import { assertNotApiOnly } from './app-surface'
import { BEHAVIOUR_AGENT_PACKAGE, BEHAVIOUR_PACKAGES, BEHAVIOURS_CONFIG, BEHAVIOURS_GIVEN_FILE, BEHAVIOURS_SETUP } from './browser-behaviour-specs'
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

/**
 * `--agent` values (RFC 0033 §13.4): whose login runs the steps, the executor the config calls for
 * it, and the adapter the runner starts it through. Nothing here imports an adapter, so its range
 * has no manifest entry to come from; each is the version §13.9's measurement ran on.
 */
export const BEHAVIOUR_AGENTS = {
  'claude-code': {
    label: 'Claude Code', executor: 'claudeCode', call: "claudeCode({ model: 'sonnet', env: emptied })",
    adapter: { name: '@agentclientprotocol/claude-agent-acp', range: '^0.107.0' },
  },
  codex: {
    label: 'Codex', executor: 'codex', call: 'codex({ env: emptied })',
    adapter: { name: '@agentclientprotocol/codex-acp', range: '^2.6.0' },
  },
} as const
export type BehaviourAgent = keyof typeof BEHAVIOUR_AGENTS
/** `none` sets up the runner with no agent: only behaviours the plan names every control of run, as locator steps. */
export type BehaviourAgentChoice = BehaviourAgent | 'none'
const AGENT_NAMES = Object.keys(BEHAVIOUR_AGENTS) as BehaviourAgent[]
const AGENT_CHOICES: BehaviourAgentChoice[] = [...AGENT_NAMES, 'none']
/** Installed at the exact versions package.json declares, the copies the config template is typechecked against. */
export const BEHAVIOUR_DEV_PACKAGES = [...BEHAVIOUR_PACKAGES, BEHAVIOUR_AGENT_PACKAGE] as const
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
  behaviours?: BehaviourAgentChoice
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

/** The lines of the config template that name its agent. The template ships for Claude Code. */
const CONFIG_AGENT_LINES = (agent: BehaviourAgent): string[] => [
  `import { ${BEHAVIOUR_AGENTS[agent].executor} } from '@e2e-dev/acp'\n`,
  `executor: ${BEHAVIOUR_AGENTS[agent].call} }`,
  `// Steps run under this machine's ${BEHAVIOUR_AGENTS[agent].label} login;`,
]

/** What `--agent none` takes out of the template: the executor's import, the agent, and the environment only an agent is handed. */
const NO_AGENT_CUTS = [
  "import { claudeCode } from '@e2e-dev/acp'\n",
  "  // Steps run under this machine's Claude Code login; a recorded step replays with no model call.\n  agents: { default: { executor: claudeCode({ model: 'sonnet', env: emptied }) } },\n",
  "// Bun loads the app's env files into this process and again into the agent's adapter, and replaces no name\n// already set. So each name goes to the agent as an empty string, over this process's value and the files'.\nconst emptied = Object.fromEntries([...loaded.flatMap((names) => Object.keys(names)), 'BROWSER_TEST_PASSWORD'].sort().map((name) => [name, '']))\n\n",
]

/** The behaviour config for `agent`: the template with the three lines that name Claude Code rewritten, or with no agent for `none`. */
export function agentConfig(config: ScaffoldFileEntry, agent: BehaviourAgentChoice): ScaffoldFileEntry {
  let contents = config.contents
  if (agent === 'none') {
    for (const cut of NO_AGENT_CUTS) {
      if (contents.split(cut).length !== 2) throw new Error(`${config.path} has no single "${cut.trim().split('\n')[0]}" to take the agent out at.`)
      contents = contents.replace(cut, '')
    }
    return { ...config, contents }
  }
  const shipped = CONFIG_AGENT_LINES('claude-code')
  const wanted = CONFIG_AGENT_LINES(agent)
  shipped.forEach((line, index) => {
    if (contents.split(line).length !== 2) throw new Error(`${config.path} has no single "${line.trim()}" to name the agent on.`)
    contents = contents.replace(line, () => wanted[index]!)
  })
  return { ...config, contents }
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
 * `--behaviours` and `--agent` name each other: whose login runs the steps, or `none`, is the person's
 * choice, so there is no default, and `--agent` alone would set up nothing.
 */
export function behaviourAgent(options: Pick<AddBrowserTestsOptions, 'behaviours' | 'agent'>): BehaviourAgentChoice | undefined {
  const choices = `${AGENT_NAMES.map((agent) => `--agent ${agent}`).join(', ')} or --agent none`
  if (!options.behaviours) {
    if (options.agent !== undefined) throw new CliError(`--agent chooses whose login runs the behaviour specs, so it goes with --behaviours. Nothing was written.`)
    return undefined
  }
  if (options.agent === undefined) {
    throw new CliError(`--behaviours needs ${choices}: the steps run under that agent's login on this machine (none runs only the behaviours the plan names every control of), and there is no default. Nothing was written.`)
  }
  const agent = AGENT_CHOICES.find((name) => name === options.agent)
  if (agent === undefined) throw new CliError(`--agent ${options.agent} names no agent the behaviour specs run on; pass ${choices}. Nothing was written.`)
  return agent
}

/**
 * The installed `@playwright/test` when it is older than the `playwright-core` the runner pins. Bun
 * may hoist the newer copy, `@axe-core/playwright`'s types then name it, and the accessibility spec
 * hands it a `page` of the older one, which stops typechecking. Unreadable versions answer nothing.
 */
async function olderPlaywright(cwd: string): Promise<{ installed: string; pinned: string } | undefined> {
  // Node's lookup, each node_modules from the app up: a workspace install hoists either package above the app.
  const manifestOf = async (name: string): Promise<{ version?: unknown; dependencies?: Record<string, unknown> } | undefined> => {
    for (let dir = resolve(cwd); ; dir = dirname(dir)) {
      const text = await readFile(join(dir, 'node_modules', name, 'package.json'), 'utf8').catch(() => undefined)
      if (text !== undefined) {
        try {
          return JSON.parse(text) as { version?: unknown; dependencies?: Record<string, unknown> }
        } catch {
          return undefined
        }
      }
      if (dirname(dir) === dir) return undefined
    }
  }
  const [test, web] = await Promise.all([manifestOf(PLAYWRIGHT_PACKAGE), manifestOf('@e2e-dev/web')])
  const installed = test?.version
  const pinned = web?.dependencies?.['playwright-core']
  if (typeof installed !== 'string' || typeof pinned !== 'string') return undefined
  return Bun.semver.order(installed, pinned) < 0 ? { installed, pinned } : undefined
}

/** Only what the manifest does not declare, so a rerun on an app that has Playwright adds axe alone. */
async function installDevPackages(cwd: string, install: boolean, agent: BehaviourAgentChoice | undefined): Promise<void> {
  const range = (name: string) => ({ name, range: cliDependencyRange('devDependencies', name) })
  const wanted = [
    ...DEV_PACKAGES.map(range),
    ...(agent === 'none' ? BEHAVIOUR_PACKAGES.map(range) : []),
    ...(agent && agent !== 'none' ? [...BEHAVIOUR_DEV_PACKAGES.map(range), BEHAVIOUR_AGENTS[agent].adapter] : []),
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
    ...(agent ? { behaviours: { signIn: account !== undefined, agent: agent !== 'none' } } : {}),
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
      ? [agentConfig(pinConfigLocale(scaffoldTemplateFile('browser-tests', BEHAVIOURS_CONFIG), pinned), agent), ...(account ? [scaffoldTemplateFile('browser-tests', BEHAVIOURS_SETUP)] : [])]
      : []),
  ]
  const created = await writeScaffoldFiles(files, { force: options.force, overwritten: options.overwritten, skipExisting: true })
  // A config kept from an earlier run may name another agent, or one at all, than this run installs an adapter for.
  const kept = agent && !created.includes(resolve(cwd, BEHAVIOURS_CONFIG)) ? await readIfExists(cwd, BEHAVIOURS_CONFIG) : null
  if (agent === 'none' && kept?.includes(`from '${BEHAVIOUR_AGENT_PACKAGE}'`)) {
    consola.warn(`${BEHAVIOURS_CONFIG} was left as it is and still imports an executor from ${BEHAVIOUR_AGENT_PACKAGE}, which --agent none does not install. Pass --force to rewrite it with no agent, or install the agent's packages.`)
  } else if (agent && agent !== 'none' && kept !== null && !kept?.includes(CONFIG_AGENT_LINES(agent)[0]!.trim())) {
    consola.warn(`${BEHAVIOURS_CONFIG} was left as it is and does not import ${BEHAVIOUR_AGENTS[agent].executor} from ${BEHAVIOUR_AGENT_PACKAGE}, so its steps run on another agent than --agent ${agent}. Pass --force to rewrite it, or change its executor by hand.`)
  }
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
  await installDevPackages(cwd, options.install ?? true, agent)
  const older = agent ? await olderPlaywright(cwd) : undefined
  if (older) {
    consola.warn(`${PLAYWRIGHT_PACKAGE} ${older.installed} is older than the playwright-core ${older.pinned} the e2e runner pins. With both installed, the accessibility spec may stop typechecking, since ${AXE_PACKAGE}'s types can name the newer copy. Run: bun add -d ${PLAYWRIGHT_PACKAGE}@^${older.pinned}`)
  }

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
