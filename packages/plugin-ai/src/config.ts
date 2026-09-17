/**
 * `config/ai.ts` (RFC 0029 §3). Providers are factories the app writes, never a
 * registry the plugin fills: nothing here imports a provider package, so a
 * bundle carries exactly the providers the config imports (RFC 0022).
 */
import { defineConfig, type AppEnv, type ConfigDefinition } from '@guren/core'
import type { EmbeddingModel, ImageModel, LanguageModel } from 'ai'

import { hasConversationDriver, type ConversationsConfig } from './conversations'
import { ConfiguredAiManager, type AiManager } from './manager'

export interface AiProviderConfig {
  /** Called once, on first use, then memoized by {@link AiManager.model}. */
  model: () => LanguageModel
  embeddingModel?: () => EmbeddingModel
  imageModel?: () => ImageModel
  /** USD per million tokens; read by the eval runner only. */
  pricing?: { input: number; output: number; cacheRead?: number; cacheWrite?: number }
}

export interface AiConfig {
  /** The provider an agent uses when it names none. Checked against `providers` at boot. */
  default: string
  providers: Readonly<Record<string, AiProviderConfig>>
  /** Where `prompt(input, { conversation })` and `continue(id)` keep history (RFC 0029 §5). Absent, both are refused. */
  conversations?: ConversationsConfig
}

// Augments `@guren/server`, the module that declares both interfaces: an
// augmentation of `@guren/core` does not merge into them. It resolves because
// `@guren/server` is this package's optional peer, as in `@guren/plugin-lambda`.
declare module '@guren/server' {
  interface ConfigDefinitions {
    ai: AiConfig
  }

  interface ServiceBindings {
    ai: AiManager
  }
}

/** A `config/ai.ts` definition, carrying its provider names for {@link InferProviders}. */
export interface AiConfigDefinition<P extends Record<string, AiProviderConfig> = Record<string, AiProviderConfig>>
  extends ConfigDefinition<'ai'> {
  /** Type-only. Never set at runtime. */
  readonly providersType?: P
}

/** The provider names of a `config/ai.ts` default export, for the `AiProviders` augmentation. */
export type InferProviders<D> = D extends AiConfigDefinition<infer P> ? { [K in keyof P]: true } : never

export function defineAiConfig<const P extends Record<string, AiProviderConfig>>(
  resolve: (env: AppEnv) => Omit<AiConfig, 'providers'> & { providers: P },
): AiConfigDefinition<P> {
  return defineConfig({
    key: 'ai',
    resolve,
    bind: (container, config) => {
      container.singleton('ai', () => new ConfiguredAiManager(config, container))
    },
    boot: (_container, config) => {
      if (!Object.hasOwn(config.providers, config.default)) {
        throw new Error(
          `config/ai.ts names "${config.default}" as its default provider, but configures only: `
          + `${describeNames(Object.keys(config.providers))}.`,
        )
      }
      if (config.conversations && !hasConversationDriver(config.conversations.driver)) {
        throw new Error(
          `config/ai.ts names the conversation driver "${config.conversations.driver}", and no registered driver has that name.`,
        )
      }
    },
  })
}

export function describeNames(names: readonly string[]): string {
  return names.length > 0 ? names.join(', ') : '(none)'
}
