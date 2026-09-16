import { consola } from 'consola'
import { ENV_SCHEMA_FILE } from './app-env'
import { CliError } from './cli-error'
import { cliDependencyRange } from './cli-manifest'
import { appDependsOn, fileExists, readIfExists } from './discovery'
import { appendEnvEntry } from './env-registrar'
import { checkPluginCompatibility, readCoreVersion, readPluginManifest } from './plugin-manifest'
import { wireConfig, wireProvider } from './provider-registrar'
import { scaffoldTemplateFile } from './scaffold-templates'
import { assertCwdUnsupported, runCommand, writeScaffoldFiles, type WriterOptions } from './utils'

export const AI_PLUGIN_PACKAGE = '@guren/plugin-ai'

interface AiProviderPreset {
  /** The AI SDK provider package; the gateway ships inside `ai` itself. */
  package?: string
  envKey: string
  envComment: string
}

const MISSING_KEY_FAILS = 'Unset, the app boots and the first prompt fails naming it.'

export const AI_PROVIDERS: Readonly<Record<string, AiProviderPreset>> = {
  anthropic: {
    package: '@ai-sdk/anthropic',
    envKey: 'ANTHROPIC_API_KEY',
    envComment: `Anthropic API key for config/ai.ts. ${MISSING_KEY_FAILS}`,
  },
  openai: {
    package: '@ai-sdk/openai',
    envKey: 'OPENAI_API_KEY',
    envComment: `OpenAI API key for config/ai.ts. ${MISSING_KEY_FAILS}`,
  },
  gateway: {
    envKey: 'AI_GATEWAY_API_KEY',
    envComment: 'Vercel AI Gateway key for config/ai.ts. On Vercel, the deployment OIDC token is used when unset.',
  },
}

export interface AddAiOptions extends WriterOptions {
  provider?: string
  /** Run `bun add` for the missing packages; otherwise print the command. */
  install?: boolean
}

/**
 * `guren add ai` (RFC 0029 §8): `config/ai.ts` for one provider, its key in
 * `config/env.ts` and the env files, `aiPlugin()` in `createApp({ providers })`,
 * and the packages. The conversation tables wait for the `database` store (§5).
 */
export async function addAi(options: AddAiOptions = {}): Promise<string[]> {
  assertCwdUnsupported(options, 'guren add ai')
  const providerName = options.provider ?? 'anthropic'
  if (!Object.hasOwn(AI_PROVIDERS, providerName)) {
    throw new CliError(
      `Unknown AI provider "${providerName}". Choose one of: ${Object.keys(AI_PROVIDERS).join(', ')}.`,
    )
  }
  const provider = AI_PROVIDERS[providerName]!

  // A config definition reads only keys `config/env.ts` declares (RFC 0027 §2), and
  // `@guren/plugin-ai` offers no provider to fall back on.
  if (!(await fileExists(process.cwd(), ENV_SCHEMA_FILE))) {
    throw new CliError(
      `guren add ai writes config/ai.ts, which reads its API key from ${ENV_SCHEMA_FILE}, and this app has none. `
      + `Declare the environment with defineEnv() in ${ENV_SCHEMA_FILE} and pass it to createApp({ env }) first.`,
    )
  }

  // Before anything is written: a re-run that skipped the config would still add the
  // other provider's key and package, and the app would keep calling the first one.
  const existing = await readIfExists(process.cwd(), 'config/ai.ts')
  if (existing !== null && !options.force && !existing.includes(`default: '${providerName}'`)) {
    throw new CliError(
      `config/ai.ts already configures another default provider. Pass --force to replace it with ${providerName}, `
      + `or add a ${providerName} entry to its providers by hand.`,
    )
  }

  const created = await writeScaffoldFiles(
    [scaffoldTemplateFile(`ai/${providerName}`, 'config/ai.ts')],
    { ...options, skipExisting: true },
  )

  await wireConfig('ai')
  await wireProvider('aiPlugin()', `import { aiPlugin } from '${AI_PLUGIN_PACKAGE}'`, {
    isRegistered: (entries) => entries.some((entry) => entry.startsWith('aiPlugin(')),
  })

  await appendEnvEntry(provider.envKey, `\n# ${provider.envComment}\n${provider.envKey}=\n`, {
    declare: { secret: true },
  })

  await installPackages(provider, Boolean(options.install))
  await warnIfCoreIncompatible()
  return created
}

async function installPackages(provider: AiProviderPreset, install: boolean): Promise<void> {
  const names = [AI_PLUGIN_PACKAGE, 'ai', ...(provider.package ? [provider.package] : [])]
  const missing: string[] = []
  for (const name of names) {
    // An unreadable manifest answers null; installing then is what the user asked for.
    if ((await appDependsOn(process.cwd(), name)) === true) continue
    // The plugin unpinned: first-party, released with this CLI. The AI SDK packages at
    // the ranges `typecheck:templates` checks config/ai.ts against.
    missing.push(name === AI_PLUGIN_PACKAGE ? name : `${name}@${cliDependencyRange('devDependencies', name)}`)
  }
  if (missing.length === 0) return

  if (install) {
    await runCommand('bun', ['add', ...missing])
  } else {
    consola.info(`Run: bun add ${missing.join(' ')}`)
  }
}

/** The plugin depends on `@guren/core`; an app below its range installs a second copy beside its own. */
async function warnIfCoreIncompatible(): Promise<void> {
  const manifest = await readPluginManifest(AI_PLUGIN_PACKAGE)
  const result = manifest && checkPluginCompatibility(manifest, await readCoreVersion())
  if (result && !result.compatible) {
    consola.warn(
      `${AI_PLUGIN_PACKAGE} supports @guren/core ${result.range}, and this app has ${result.coreVersion}. `
      + 'Upgrade @guren/core, or the plugin runs against a second copy of it.',
    )
  }
}
