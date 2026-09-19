/**
 * `config/ai.ts` (RFC 0029 §3). Providers are factories the app writes, never a
 * registry the plugin fills: nothing here imports a provider package, so a
 * bundle carries exactly the providers the config imports (RFC 0022).
 */
import { defineConfig, type AppEnv, type ConfigDefinition } from '@guren/core'
import type { EmbeddingModel, Experimental_EvaluationModel, ImageModel, LanguageModel } from 'ai'

import { createConversationStore, type ConversationsConfig } from './conversations'
import { ConfiguredAiManager, type AiManager } from './manager'
import type { AiPricing } from './types'

/** An instance, never a string id: the SDK resolves those through its own default provider, around `config/ai.ts`. */
export type AiEvaluationModel = Exclude<Experimental_EvaluationModel, string>

export interface AiProviderConfig {
  /** Called once, on first use, then memoized by {@link AiManager.model}. Optional, so a provider may exist for evaluation alone. */
  model?: () => LanguageModel
  embeddingModel?: () => EmbeddingModel
  imageModel?: () => ImageModel
  /** Called once by {@link AiManager.evaluationModel}. A gateway entry returns `gateway.evaluationModel('typesafe-ai/jev')`. */
  evaluationModel?: () => AiEvaluationModel
  /** Read by the eval runner only (RFC 0029 §10); a provider without it yields rows with no cost. */
  pricing?: AiPricing
}

export interface AiConfig {
  /**
   * The provider an agent uses when it names none. Checked against `providers` at boot; whether it
   * configures `model` is not, so an evaluation-only app (Jev alone) can name its one entry here.
   */
  default: string
  /** The provider `evaluate()` uses when the call names none; `default` when absent. Checked at boot. */
  defaultEvaluation?: string
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
      for (const role of ['default', 'defaultEvaluation'] as const) {
        const name = config[role]
        if (name !== undefined && !Object.hasOwn(config.providers, name)) {
          throw new Error(
            `config/ai.ts names "${name}" as its ${role} provider, but configures only: `
            + `${describeNames(Object.keys(config.providers))}.`,
          )
        }
      }
      // Built and discarded, so an unknown driver or an unset table fails the boot rather than the first conversation.
      if (config.conversations) createConversationStore(config.conversations)
    },
  })
}

export function describeNames(names: readonly string[]): string {
  return names.length > 0 ? names.join(', ') : '(none)'
}
