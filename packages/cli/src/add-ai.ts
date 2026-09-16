import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { consola } from 'consola'
import { ENV_SCHEMA_FILE } from './app-env'
import { CliError } from './cli-error'
import { appDependsOn, fileExists } from './discovery'
import type { DependencyManifest } from './drizzle-pins'
import { appendEnvEntry } from './env-registrar'
import { addArrayOptionRegistration, APP_ENTRY_CANDIDATES, resolveAppEntry, wireConfig } from './provider-registrar'
import { scaffoldTemplateFile } from './scaffold-templates'
import { runCommand, writeScaffoldFiles, type WriterOptions } from './utils'

export const AI_PLUGIN_PACKAGE = '@guren/plugin-ai'

interface AiProviderPreset {
  /** The AI SDK provider package; the gateway ships inside `ai` itself. */
  package?: string
  envKey: string
  envComment: string
}

export const AI_PROVIDERS = {
  anthropic: {
    package: '@ai-sdk/anthropic',
    envKey: 'ANTHROPIC_API_KEY',
    envComment: 'Anthropic API key for config/ai.ts. Unset, the app boots and the first prompt fails.',
  },
  openai: {
    package: '@ai-sdk/openai',
    envKey: 'OPENAI_API_KEY',
    envComment: 'OpenAI API key for config/ai.ts. Unset, the app boots and the first prompt fails.',
  },
  gateway: {
    envKey: 'AI_GATEWAY_API_KEY',
    envComment: 'Vercel AI Gateway key for config/ai.ts. On Vercel, the deployment OIDC token is used when unset.',
  },
} as const satisfies Record<string, AiProviderPreset>

export type AiProviderPresetName = keyof typeof AI_PROVIDERS

export interface AddAiOptions extends WriterOptions {
  provider?: string
  /** Run `bun add` for the missing packages; otherwise print the command. */
  install?: boolean
}

/**
 * The range `add ai` installs for an AI SDK package: this package's own dev dependency,
 * which `typecheck:templates` checks the `config/ai.ts` templates against, so the version
 * a template was proven with and the version an app gets are one number.
 */
export function aiPackageRange(name: string): string {
  const manifestPath = fileURLToPath(new URL('../package.json', import.meta.url))
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as DependencyManifest
  const range = manifest.devDependencies?.[name]
  if (range === undefined) {
    throw new Error(`@guren/cli declares no ${name} range — add ai has nothing to install`)
  }
  return range
}

/**
 * `guren add ai` (RFC 0029 §8): `config/ai.ts` for one provider, its key in
 * `config/env.ts` and the env files, `aiPlugin()` in `createApp({ providers })`,
 * and the packages. The conversation tables wait for the `database` store (§5).
 */
export async function addAi(options: AddAiOptions = {}): Promise<string[]> {
  const providerName = options.provider ?? 'anthropic'
  if (!Object.hasOwn(AI_PROVIDERS, providerName)) {
    throw new CliError(
      `Unknown AI provider "${providerName}". Choose one of: ${Object.keys(AI_PROVIDERS).join(', ')}.`,
    )
  }
  const provider: AiProviderPreset = AI_PROVIDERS[providerName as AiProviderPresetName]

  // A config definition reads only keys `config/env.ts` declares (RFC 0027 §2), and
  // `@guren/plugin-ai` offers no provider to fall back on.
  if (!(await fileExists(process.cwd(), ENV_SCHEMA_FILE))) {
    throw new CliError(
      `guren add ai writes config/ai.ts, which reads its API key from ${ENV_SCHEMA_FILE}, and this app has none. `
      + `Declare the environment with defineEnv() in ${ENV_SCHEMA_FILE} and pass it to createApp({ env }) first.`,
    )
  }

  const created = await writeScaffoldFiles(
    [scaffoldTemplateFile(`ai/${providerName}`, 'config/ai.ts')],
    { ...options, skipExisting: true },
  )

  await wireConfig('ai')
  await wirePlugin()

  await appendEnvEntry(provider.envKey, `\n# ${provider.envComment}\n${provider.envKey}=\n`, {
    declare: { secret: true },
  })

  await installPackages(provider, Boolean(options.install))
  return created
}

async function wirePlugin(): Promise<void> {
  const entry = 'aiPlugin()'
  const importStatement = `import { aiPlugin } from '${AI_PLUGIN_PACKAGE}'`
  const appPath = await resolveAppEntry()
  const manual = `Add ${entry} to your createApp() providers array by hand: ${importStatement}`
  if (!appPath) {
    consola.warn(`Could not find ${APP_ENTRY_CANDIDATES.join(' or ')} — ${entry} was not registered.`)
    consola.info(manual)
    return
  }
  // A configured `aiPlugin({ approvals })` counts as registered.
  const wiring = await addArrayOptionRegistration(
    appPath,
    'providers',
    entry,
    importStatement,
    (entries) => entries.some((existing) => existing.startsWith('aiPlugin(')),
  )
  if (!wiring.registered) {
    consola.warn(`Could not register ${entry} in ${appPath}: ${wiring.entry.reason}.`)
    consola.info(manual)
  }
}

async function installPackages(provider: AiProviderPreset, install: boolean): Promise<void> {
  // The plugin unpinned: a first-party package, at whatever release the registry calls latest.
  const wanted: Array<[name: string, spec: string]> = [
    [AI_PLUGIN_PACKAGE, AI_PLUGIN_PACKAGE],
    ['ai', `ai@${aiPackageRange('ai')}`],
    ...(provider.package ? [[provider.package, `${provider.package}@${aiPackageRange(provider.package)}`] as [string, string]] : []),
  ]
  const missing: string[] = []
  for (const [name, spec] of wanted) {
    // An unreadable manifest answers null; installing then is what the user asked for.
    if ((await appDependsOn(process.cwd(), name)) !== true) missing.push(spec)
  }
  if (missing.length === 0) return

  if (install) {
    await runCommand('bun', ['add', ...missing])
  } else {
    consola.info(`Run: bun add ${missing.join(' ')}`)
  }
}
