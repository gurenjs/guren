import { consola } from 'consola'
import { writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { findFirstExisting, readIfExists } from './discovery'
import { insertImport, insertProvider, PATCH_REASONS, type PatchResult } from './patch-helpers'
import { relativeImportPath } from './utils'

/**
 * Entry files that may hold the app's `createApp({ ... })` call, in the order
 * they are probed. The default template ships `src/app.ts`; a flattened app
 * keeps `app.ts` at the root. One list for every command that patches the app
 * entry — two copies is how `guren add auth` came to find a root `app.ts`
 * while `guren add cache` warned that `src/app.ts` was missing.
 */
export const APP_ENTRY_CANDIDATES = ['src/app.ts', 'app.ts'] as const

/** The first existing app entry under `cwd`, or `null` when the project has none. */
export async function resolveAppEntry(cwd: string = process.cwd()): Promise<string | null> {
  return findFirstExisting(cwd, APP_ENTRY_CANDIDATES)
}

export type ProviderWiring =
  | { registered: false; provider: PatchResult }
  | { registered: true; provider: PatchResult; import: PatchResult }

/**
 * Registers `providerName` in `appPath`'s `providers: [...]` array and adds
 * `importStatement`, in **one write**.
 *
 * Both halves have to land together or neither may: an import whose
 * registration never happened is an unused binding that stops the app
 * compiling under `noUnusedLocals`, and a registration whose import never
 * happened is an unresolved identifier — worse, since it also throws at
 * runtime. Two sequenced file-level patches can produce either one; composing
 * the pure `insertProvider`/`insertImport` transforms and writing once cannot.
 * This is the shape `addRouteRegistrarCall` already uses for the same reason.
 *
 * Silent by design: callers with a reporting policy of their own (`guren
 * plugin` throws and collects structured messages) read the outcome instead of
 * the console.
 */
export async function addProviderRegistration(
  appPath: string,
  providerName: string,
  importStatement: string,
  isRegistered?: (entries: string[]) => boolean,
): Promise<ProviderWiring> {
  const content = await readIfExists(process.cwd(), appPath)

  if (content === null) {
    return { registered: false, provider: { modified: false, reason: PATCH_REASONS.fileNotFound } }
  }

  const inserted = insertProvider(content, providerName, isRegistered)
  const alreadyRegistered = inserted.reason === PATCH_REASONS.providerAlreadyRegistered

  if (inserted.content === undefined && !alreadyRegistered) {
    return { registered: false, provider: { modified: false, reason: inserted.reason } }
  }

  // An already-registered provider still needs its import checked: the two can
  // fall out of sync when a user removes one by hand.
  const withProvider = inserted.content ?? content
  const withImport = insertImport(withProvider, importStatement)

  const provider: PatchResult = alreadyRegistered
    ? { modified: false, reason: PATCH_REASONS.providerAlreadyRegistered }
    : { modified: true }
  const importResult: PatchResult = withImport === null
    ? { modified: false, reason: PATCH_REASONS.importAlreadyExists }
    : { modified: true }

  if (provider.modified || importResult.modified) {
    await writeFile(resolve(process.cwd(), appPath), withImport ?? withProvider, 'utf8')
  }

  return { registered: true, provider, import: importResult }
}

export interface WireProviderOptions {
  /** App entry to patch; resolved from {@link APP_ENTRY_CANDIDATES} when omitted. */
  appPath?: string
  /** Also report each success / already-present step (the interactive `guren add auth` flow). */
  verbose?: boolean
}

/** The import line for a provider scaffolded as `app/Providers/<Name>.ts`. */
function scaffoldedProviderImport(appPath: string, providerName: string): string {
  return `import ${providerName} from '${relativeImportPath(appPath, `app/Providers/${providerName}.js`)}'`
}

/** What the app author has to do by hand for a provider this could not wire. */
function reportManualStep(providerName: string, importStatement: string): void {
  consola.info(`Add ${providerName} to your createApp() providers array by hand: ${importStatement}`)
}

function warnNoAppEntry(providerName: string, importStatement: string): void {
  consola.warn(`Could not find ${APP_ENTRY_CANDIDATES.join(' or ')} — ${providerName} was not registered.`)
  reportManualStep(providerName, importStatement)
}

function report(
  appPath: string,
  providerName: string,
  importStatement: string,
  wiring: ProviderWiring,
  verbose: boolean,
): void {
  if (!wiring.registered) {
    consola.warn(`Could not register ${providerName} in ${appPath}: ${wiring.provider.reason}.`)
    reportManualStep(providerName, importStatement)
    return
  }

  if (!verbose) return

  if (wiring.import.modified) {
    consola.success(`Added ${providerName} import to ${appPath}`)
  } else {
    consola.info(`${providerName} import already exists in ${appPath}`)
  }

  if (wiring.provider.modified) {
    consola.success(`Added ${providerName} to providers array in ${appPath}`)
  } else {
    consola.info(`${providerName} already registered in ${appPath}`)
  }
}

/**
 * `addProviderRegistration` against the app's entry file, reporting every
 * failure.
 */
export async function wireProvider(
  providerName: string,
  importStatement: string,
  options: WireProviderOptions = {},
): Promise<void> {
  const appPath = options.appPath ?? (await resolveAppEntry())

  if (!appPath) {
    warnNoAppEntry(providerName, importStatement)
    return
  }

  const wiring = await addProviderRegistration(appPath, providerName, importStatement)
  report(appPath, providerName, importStatement, wiring, Boolean(options.verbose))
}

/**
 * `wireProvider` for a provider scaffolded at `app/Providers/<Name>.ts` — the
 * one place that knows those are default exports, and that their import is
 * relative to whichever entry was found.
 */
export async function wireAppProvider(providerName: string, options: WireProviderOptions = {}): Promise<void> {
  const appPath = options.appPath ?? (await resolveAppEntry())

  if (!appPath) {
    // The import is only derivable from an entry, so name the conventional one.
    warnNoAppEntry(providerName, scaffoldedProviderImport(APP_ENTRY_CANDIDATES[0], providerName))
    return
  }

  await wireProvider(providerName, scaffoldedProviderImport(appPath, providerName), { ...options, appPath })
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

/**
 * Wires several providers into the app entry, resolving that entry **once**.
 *
 * A blueprint installs Core's service provider alongside its own; resolving
 * per provider probes the filesystem twice for an answer that cannot change
 * mid-run, and reports the missing-entry warning once per provider rather than
 * once per command.
 */
export async function wireProviders(
  registrations: readonly ProviderRegistration[],
  options: WireProviderOptions = {},
): Promise<void> {
  const appPath = options.appPath ?? (await resolveAppEntry())

  // Named one by one even with no entry to patch: a blueprint installs Core's
  // provider *and* its own, and an app missing either one is missing the
  // feature — so a single warning naming the pair would under-report the work
  // left to the author.
  for (const { name, importStatement } of registrations) {
    const statement = importStatement ?? scaffoldedProviderImport(appPath ?? APP_ENTRY_CANDIDATES[0], name)

    if (!appPath) {
      warnNoAppEntry(name, statement)
      continue
    }

    await wireProvider(name, statement, { ...options, appPath })
  }
}
