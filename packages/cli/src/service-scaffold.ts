import { ENV_SCHEMA_FILE } from './app-env'
import { appendEnvEntry } from './env-registrar'
import { appBindsService, callsDefineConfig, fileExists, readIfExists } from './discovery'
import { wireConfig, wireProviders } from './provider-registrar'
import { definitionTemplateFile, scaffoldTemplateFile } from './scaffold-templates'
import { writeScaffoldFiles, type ScaffoldFilesOptions } from './utils'

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
  /** The env key both forms read, and the block `.env.example` and `.env` get. */
  env: { key: string; entry: string }
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

/** Writes and wires `scaffold` as a definition or a provider, per {@link installsConfigDefinition}. */
export async function installServiceScaffold(scaffold: ServiceScaffold, options: ScaffoldFilesOptions): Promise<string[]> {
  const { key, coreProvider, provider, definitionProviders = [], shared = [], env } = scaffold
  const definition = await installsConfigDefinition(key)
  const files = definition
    ? [`config/${key}.ts`, ...definitionProviders.map((name) => `app/Providers/${name}.ts`)].map((path) => definitionTemplateFile(key, path))
    : [scaffoldTemplateFile(key, `app/Providers/${provider}.ts`)]
  const created = await writeScaffoldFiles([...files, ...shared.map((path) => scaffoldTemplateFile(key, path))], options)

  if (definition) {
    await wireConfig(key)
    if (definitionProviders.length > 0) await wireProviders(definitionProviders.map((name) => ({ name })))
  } else {
    await wireProviders([
      { name: `Core${coreProvider}`, importStatement: `import { ${coreProvider} as Core${coreProvider} } from '@guren/core'` },
      { name: provider },
    ])
  }

  await appendEnvEntry(env.key, env.entry, { declare: true })
  return created
}
