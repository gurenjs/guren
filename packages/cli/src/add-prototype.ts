/**
 * `guren add prototype` (RFC 0021 Part 3): the fixture module, the two
 * scripts, and the two wiring lines — `startInertiaClient({ prototype })` in
 * the client entry, `createApp({ prototype })` in the app entry — plus the
 * ambient `GUREN_PROTOTYPE` declaration. Every step is idempotent, so a
 * re-run repairs what is missing. `--remove` reverses the wiring and the
 * scripts and leaves the fixture, which the author may still want.
 */
import { writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { consola } from 'consola'
import { assertNotApiOnly } from './app-surface'
import { readIfExists } from './discovery'
import { addCreateAppOption, PATCH_REASONS } from './patch-helpers'
import { PROTOTYPE_FIXTURE_FILE, PROTOTYPE_OPTION_PATTERN } from './prototype-check'
import { scaffoldTemplateFile } from './scaffold-templates'
import { writeRoot, writeScaffoldFiles, type WriterOptions } from './utils'

/** One literal for the file this writes and `guren check` reads; owned there, since `check` must not load a scaffolder. */
export const PROTOTYPE_FIXTURE_PATH = PROTOTYPE_FIXTURE_FILE
const CLIENT_ENTRY = 'resources/js/app.tsx'
const APP_ENTRY = 'src/app.ts'
const ENV_DECLARATION_FILE = 'resources/js/vite-env.d.ts'

export const PROTOTYPE_SCRIPTS: Readonly<Record<string, string>> = {
  'dev:prototype': 'bunx vite --mode prototype',
  'build:prototype': 'bunx guren codegen && bunx guren check --prototype && bunx vite build --mode prototype',
}

/** The `createApp()` option, as `addCreateAppOption` inserts it and `--remove` finds it. */
export const APP_OPTION_SOURCE = "() => import('../resources/js/prototype/index.js')"

/** The client wiring, inserted after `startInertiaClient({`. Comment included: it names why the branch is dead in production. */
const CLIENT_WIRING = `
    // \`vite --mode prototype\` defines GUREN_PROTOTYPE as true; a literal false
    // elsewhere, so this branch and its import drop out of the production bundle (RFC 0021).
    prototype: import.meta.env.GUREN_PROTOTYPE
      ? { load: () => import('./prototype/index.js'), base: import.meta.env.BASE_URL }
      : undefined,`

const ENV_DECLARATION = `
interface ImportMetaEnv {
  /** \`true\` under \`vite --mode prototype\`, \`false\` in every other build (RFC 0021). */
  readonly GUREN_PROTOTYPE: boolean
}
`

export interface AddPrototypeOptions extends WriterOptions {
  /** Reverse the wiring and the scripts; the fixture directory is left alone. */
  remove?: boolean
}

export async function addPrototype(options: AddPrototypeOptions = {}): Promise<string[]> {
  const cwd = writeRoot(options)
  if (options.remove) {
    return removePrototype(cwd)
  }

  await assertNotApiOnly(cwd, {
    does: 'guren add prototype wires a fixture into the Inertia client entry',
    instead: 'An API-only app has no pages to prototype; scaffold the Inertia blueprint for a customer-facing prototype',
  })

  const created = await writeScaffoldFiles(
    [scaffoldTemplateFile('prototype', PROTOTYPE_FIXTURE_PATH)],
    { ...options, skipExisting: true },
  )

  await wireClientEntry(cwd)
  await wireAppEntry(cwd)
  await ensureEnvDeclaration(cwd)
  await patchScripts(cwd, 'add')

  consola.info('Next steps:')
  consola.info(`  • Add entries to ${PROTOTYPE_FIXTURE_PATH}, or run: bunx guren make:feature <Entity> --fields "…" --prototype`)
  consola.info('  • Walk it locally: bun run dev:prototype')
  consola.info('  • Ship it: bun run build:prototype, then host dist/prototype/ statically')
  return created
}

async function wireClientEntry(cwd: string): Promise<void> {
  const content = await readIfExists(cwd, CLIENT_ENTRY)
  if (content === null) {
    consola.warn(`${CLIENT_ENTRY} not found — pass \`prototype\` to startInertiaClient() by hand:${CLIENT_WIRING}`)
    return
  }
  if (PROTOTYPE_OPTION_PATTERN.test(content)) return

  const anchor = 'startInertiaClient({'
  const index = content.indexOf(anchor)
  if (index === -1) {
    consola.warn(`${CLIENT_ENTRY} has no startInertiaClient({ … }) call — pass \`prototype\` to it by hand:${CLIENT_WIRING}`)
    return
  }
  const insertAt = index + anchor.length
  await writeFile(resolve(cwd, CLIENT_ENTRY), `${content.slice(0, insertAt)}${CLIENT_WIRING}${content.slice(insertAt)}`, 'utf8')
  consola.success(`Wired the prototype loader into ${CLIENT_ENTRY}`)
}

async function wireAppEntry(cwd: string): Promise<void> {
  const previous = process.cwd()
  process.chdir(cwd)
  try {
    const result = await addCreateAppOption(APP_ENTRY, 'prototype', APP_OPTION_SOURCE)
    if (result.modified) {
      consola.success(`Wired the prototype loader into ${APP_ENTRY}`)
    } else if (result.reason !== PATCH_REASONS.optionAlreadySet) {
      consola.warn(`${APP_ENTRY}: ${result.reason} — add \`prototype: ${APP_OPTION_SOURCE}\` to createApp() by hand.`)
    }
  } finally {
    process.chdir(previous)
  }
}

async function ensureEnvDeclaration(cwd: string): Promise<void> {
  const existing = await readIfExists(cwd, ENV_DECLARATION_FILE)
  if (existing?.includes('GUREN_PROTOTYPE')) return
  await writeFile(resolve(cwd, ENV_DECLARATION_FILE), `${existing ?? ''}${ENV_DECLARATION}`, 'utf8')
  consola.success(`Declared import.meta.env.GUREN_PROTOTYPE in ${ENV_DECLARATION_FILE}`)
}

interface Manifest {
  scripts?: Record<string, string>
  [key: string]: unknown
}

async function patchScripts(cwd: string, mode: 'add' | 'remove'): Promise<void> {
  const manifestPath = resolve(cwd, 'package.json')
  const raw = await readIfExists(cwd, 'package.json')
  if (raw === null) {
    consola.warn('package.json not found — add the dev:prototype and build:prototype scripts by hand.')
    return
  }
  const manifest = JSON.parse(raw) as Manifest
  const scripts = { ...manifest.scripts }
  let changed = false

  for (const [name, command] of Object.entries(PROTOTYPE_SCRIPTS)) {
    if (mode === 'add' && scripts[name] === undefined) {
      scripts[name] = command
      changed = true
    }
    // Removed only when still the scripted command: an edited script is the author's.
    if (mode === 'remove' && scripts[name] === command) {
      delete scripts[name]
      changed = true
    }
  }

  if (!changed) return
  manifest.scripts = scripts
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  consola.success(mode === 'add' ? 'Added the dev:prototype and build:prototype scripts' : 'Removed the prototype scripts')
}

async function removePrototype(cwd: string): Promise<string[]> {
  const client = await readIfExists(cwd, CLIENT_ENTRY)
  if (client !== null && client.includes(CLIENT_WIRING)) {
    await writeFile(resolve(cwd, CLIENT_ENTRY), client.replace(CLIENT_WIRING, ''), 'utf8')
    consola.success(`Removed the prototype loader from ${CLIENT_ENTRY}`)
  } else if (client !== null && PROTOTYPE_OPTION_PATTERN.test(client)) {
    consola.warn(`${CLIENT_ENTRY} passes \`prototype\` to startInertiaClient() in a shape this cannot recognise — remove it by hand.`)
  }

  const app = await readIfExists(cwd, APP_ENTRY)
  const optionLine = `\n  prototype: ${APP_OPTION_SOURCE},`
  if (app !== null && app.includes(optionLine)) {
    await writeFile(resolve(cwd, APP_ENTRY), app.replace(optionLine, ''), 'utf8')
    consola.success(`Removed the prototype loader from ${APP_ENTRY}`)
  } else if (app !== null && PROTOTYPE_OPTION_PATTERN.test(app)) {
    consola.warn(`${APP_ENTRY} passes \`prototype\` to createApp() in a shape this cannot recognise — remove it by hand.`)
  }

  await patchScripts(cwd, 'remove')

  consola.info(`Left in place: ${PROTOTYPE_FIXTURE_PATH} and the GUREN_PROTOTYPE declaration in ${ENV_DECLARATION_FILE}; delete them when the fixture has no further use.`)
  return []
}

/** Whether the fixture exists, which `make:feature --prototype` needs before it can append entries. */
export async function appHasPrototypeFixture(cwd: string = process.cwd()): Promise<boolean> {
  return (await readIfExists(cwd, PROTOTYPE_FIXTURE_PATH)) !== null
}
