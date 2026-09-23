import { ENV_SCHEMA_FILE } from './app-env'
import { appendEnvEntry, type AppendEnvEntryOptions } from './env-registrar'
import { appBindsService, callsDefineConfig, fileExists, readIfExists } from './discovery'
import { wireConfig, wireProviders } from './provider-registrar'
import { definitionTemplateFile, scaffoldTemplateFile } from './scaffold-templates'
import { writeScaffoldFiles, type ScaffoldFileEntry, type ScaffoldFilesOptions } from './utils'

/** A blueprint installing one container service, in either form it ships (RFC 0027 §2). */
export interface ServiceScaffold {
  /** The container key, which also names the scaffold directory and `config/<key>.ts`. */
  key: string
  /** The `@guren/core` provider class the provider form registers ahead of its own. */
  coreProvider: string
  /** The provider form's `app/Providers/<provider>.ts`. */
  provider: string
  /** Providers the definition form still needs, for work a definition cannot do. */
  definitionProviders?: readonly string[]
  /** Files both forms write. */
  shared?: readonly string[]
  /** The env keys both forms read, each with the block `.env.example` and `.env` get. */
  env: readonly ScaffoldEnvEntry[]
  /** Env keys only the definition reads. */
  definitionEnv?: readonly ScaffoldEnvEntry[]
}

export interface ScaffoldEnvEntry {
  key: string
  entry: string
  /** The `config/env.ts` builder; a string defaulting to the assigned value when absent. */
  declare?: Exclude<AppendEnvEntryOptions['declare'], true>
}

/** The env entries `scaffold` reads in the form `definition` names. */
export function scaffoldEnv(scaffold: ServiceScaffold, definition: boolean): readonly ScaffoldEnvEntry[] {
  return definition ? [...scaffold.env, ...(scaffold.definitionEnv ?? [])] : scaffold.env
}

/** Appends and declares each of `entries`, in order. */
export async function appendScaffoldEnv(entries: readonly ScaffoldEnvEntry[]): Promise<void> {
  for (const { key, entry, declare } of entries) {
    await appendEnvEntry(key, entry, { declare: declare ?? true })
  }
}

/**
 * Whether a blueprint installs `key` as a `config/<key>.ts` definition rather than
 * a provider. It needs `config/env.ts`, since a definition reads declared keys only;
 * no provider already binding `key`, since a second binding fails the boot; and no
 * `config/<key>.ts` other than a definition, which a re-run keeps and `config` cannot list.
 */
export async function installsConfigDefinition(key: string): Promise<boolean> {
  const cwd = process.cwd()
  if (!(await fileExists(cwd, ENV_SCHEMA_FILE)) || (await appBindsService(key, cwd)).length > 0) return false
  const existing = await readIfExists(cwd, `config/${key}.ts`)
  return existing === null || callsDefineConfig(existing, key)
}

/**
 * Writes and wires `scaffold` as a definition or a provider, per {@link installsConfigDefinition}.
 * `samples` (a blueprint's sample job or mailable) are written in the same batch, so a file in
 * the way refuses them too.
 */
export async function installServiceScaffold(
  scaffold: ServiceScaffold,
  options: ScaffoldFilesOptions,
  samples: readonly ScaffoldFileEntry[] = [],
): Promise<string[]> {
  const { key, coreProvider, provider, definitionProviders = [], shared = [] } = scaffold
  const definition = await installsConfigDefinition(key)
  const files = definition
    ? [`config/${key}.ts`, ...definitionProviders.map((name) => `app/Providers/${name}.ts`)].map((path) => definitionTemplateFile(key, path))
    : [scaffoldTemplateFile(key, `app/Providers/${provider}.ts`)]
  const created = await writeScaffoldFiles([...samples, ...files, ...shared.map((path) => scaffoldTemplateFile(key, path))], options)

  if (definition) {
    await wireConfig(key)
    if (definitionProviders.length > 0) await wireProviders(definitionProviders.map((name) => ({ name })))
  } else {
    await wireProviders([
      { name: `Core${coreProvider}`, importStatement: `import { ${coreProvider} as Core${coreProvider} } from '@guren/core'` },
      { name: provider },
    ])
  }

  await appendScaffoldEnv(scaffoldEnv(scaffold, definition))
  return created
}
