import { consola } from 'consola'
import { writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { findFirstExisting, readIfExists } from './discovery'
import { defaultImportBinding, insertArrayOptionEntry, insertImport, PATCH_REASONS, type PatchResult } from './patch-helpers'
import { relativeImportPath } from './utils'

/**
 * Entry files that may hold `createApp({ ... })`, in probe order. One list for every
 * command that patches the app entry — two copies is how `guren add auth` came to find
 * a root `app.ts` while `guren add cache` warned that `src/app.ts` was missing.
 */
export const APP_ENTRY_CANDIDATES = ['src/app.ts', 'app.ts'] as const

/** The first existing app entry under `cwd`, or `null` when the project has none. */
export async function resolveAppEntry(cwd: string = process.cwd()): Promise<string | null> {
  return findFirstExisting(cwd, APP_ENTRY_CANDIDATES)
}

export type EntryWiring =
  | { registered: false; entry: PatchResult }
  | { registered: true; entry: PatchResult; import: PatchResult }

/** The default export of a scaffolded file: `local` from `target`, a project path without extension. */
export interface DefaultExportImport {
  local: string
  target: string
}

/**
 * Adds `entry` to `appPath`'s `createApp({ <key>: [...] })` array and adds its import,
 * in **one write**: a lone import breaks `noUnusedLocals`, a lone registration is an
 * unresolved identifier, and two sequenced patches can leave either. A default export
 * the entry already imports keeps its binding, under whatever name and specifier: a
 * second import is a duplicate declaration, and a second entry a second definition.
 */
export async function addArrayOptionRegistration(
  appPath: string,
  key: 'providers' | 'config',
  entry: string,
  importFor: string | DefaultExportImport,
  isRegistered?: (entries: string[]) => boolean,
): Promise<EntryWiring> {
  const content = await readIfExists(process.cwd(), appPath)

  if (content === null) {
    return { registered: false, entry: { modified: false, reason: PATCH_REASONS.fileNotFound } }
  }

  const bound = typeof importFor === 'string' ? null : defaultImportBinding(content, appPath, importFor.target)
  const inserted = insertArrayOptionEntry(content, key, bound ?? entry, { isRegistered })
  const alreadyRegistered = inserted.reason === PATCH_REASONS.alreadyPresent

  if (inserted.content === undefined && !alreadyRegistered) {
    return { registered: false, entry: { modified: false, reason: inserted.reason } }
  }

  // An already-registered entry still needs its import checked: the two can
  // fall out of sync when a user removes one by hand.
  const withEntry = inserted.content ?? content
  const withImport = bound === null ? insertImport(withEntry, importStatementFor(importFor, appPath)) : null

  const entryResult: PatchResult = alreadyRegistered
    ? { modified: false, reason: PATCH_REASONS.alreadyPresent }
    : { modified: true }
  const importResult: PatchResult = withImport === null
    ? { modified: false, reason: PATCH_REASONS.importAlreadyExists }
    : { modified: true }

  if (entryResult.modified || importResult.modified) {
    await writeFile(resolve(process.cwd(), appPath), withImport ?? withEntry, 'utf8')
  }

  return { registered: true, entry: entryResult, import: importResult }
}

function importStatementFor(importFor: string | DefaultExportImport, appPath: string): string {
  return typeof importFor === 'string'
    ? importFor
    : `import ${importFor.local} from '${relativeImportPath(appPath, `${importFor.target}.js`)}'`
}

export interface WireProviderOptions {
  /** App entry to patch; resolved from {@link APP_ENTRY_CANDIDATES} when omitted. */
  appPath?: string
  /** Also report each success / already-present step (the interactive `guren add auth` flow). */
  verbose?: boolean
  /** Counts an existing entry as this one, e.g. a configured `aiPlugin({ ... })` for `aiPlugin()`. */
  isRegistered?: (entries: string[]) => boolean
}

/** What the app author has to do by hand for an entry this could not wire. */
function reportManualStep(key: string, entry: string, importStatement: string): void {
  consola.info(`Add ${entry} to your createApp() ${key} array by hand: ${importStatement}`)
}

function warnNoAppEntry(key: string, entry: string, importStatement: string): void {
  consola.warn(`Could not find ${APP_ENTRY_CANDIDATES.join(' or ')} — ${entry} was not registered.`)
  reportManualStep(key, entry, importStatement)
}

async function wireArrayOption(
  key: 'providers' | 'config',
  entry: string,
  importFor: string | DefaultExportImport,
  options: WireProviderOptions,
): Promise<void> {
  const appPath = options.appPath ?? (await resolveAppEntry())
  // With no entry the import is still derived, from the conventional one, for the manual step.
  const importStatement = importStatementFor(importFor, appPath ?? APP_ENTRY_CANDIDATES[0])

  if (!appPath) {
    warnNoAppEntry(key, entry, importStatement)
    return
  }

  const wiring = await addArrayOptionRegistration(appPath, key, entry, importFor, options.isRegistered)

  if (!wiring.registered) {
    consola.warn(`Could not register ${entry} in ${appPath}: ${wiring.entry.reason}.`)
    reportManualStep(key, entry, importStatement)
    return
  }

  if (!options.verbose) return

  if (wiring.import.modified) {
    consola.success(`Added ${entry} import to ${appPath}`)
  } else {
    consola.info(`${entry} import already exists in ${appPath}`)
  }

  if (wiring.entry.modified) {
    consola.success(`Added ${entry} to ${key} array in ${appPath}`)
  } else {
    consola.info(`${entry} already registered in ${appPath}`)
  }
}

/** Registers a provider in the app entry's `providers` array, reporting every failure. */
export async function wireProvider(
  providerName: string,
  importStatement: string,
  options: WireProviderOptions = {},
): Promise<void> {
  await wireArrayOption('providers', providerName, importStatement, options)
}

/** Registers the definition `config/<binding>.ts` default-exports (RFC 0027 §2) in the `config` array. */
export async function wireConfig(binding: string, options: WireProviderOptions = {}): Promise<void> {
  await wireArrayOption('config', binding, { local: binding, target: `config/${binding}` }, options)
}

/** `wireProvider` for a provider scaffolded at `app/Providers/<Name>.ts`, a default export. */
export async function wireAppProvider(providerName: string, options: WireProviderOptions = {}): Promise<void> {
  await wireArrayOption('providers', providerName, scaffoldedProvider(providerName), options)
}

export interface ProviderRegistration {
  /** Identifier to add to `providers: [ ... ]`. */
  name: string
  /**
   * Import to add. Omitted for a provider scaffolded at
   * `app/Providers/<name>.ts`, whose import is derived from the resolved entry.
   */
  importStatement?: string
}

/** Wires several providers into the app entry, resolving that entry **once**. */
export async function wireProviders(
  registrations: readonly ProviderRegistration[],
  options: WireProviderOptions = {},
): Promise<void> {
  const appPath = options.appPath ?? (await resolveAppEntry())

  // Warned one by one even with no entry to patch: an app missing any one of a
  // blueprint's providers is missing the feature, so a single warning under-reports.
  for (const { name, importStatement } of registrations) {
    await wireArrayOption('providers', name, importStatement ?? scaffoldedProvider(name), { ...options, appPath: appPath ?? undefined })
  }
}

function scaffoldedProvider(providerName: string): DefaultExportImport {
  return { local: providerName, target: `app/Providers/${providerName}` }
}
