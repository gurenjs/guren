import type { Container } from '@guren/core'
import type { EmbeddingModel, ImageModel, LanguageModel } from 'ai'

import { bindAgent, type Agent, type AgentClass, type AgentPrincipalInput, type BoundAgent } from './agent'
import { describeNames, type AiConfig, type AiEvaluationModel, type AiProviderConfig } from './config'
import { createConversationStore, type ConversationStore } from './conversations'
import type { AiProviderName } from './types'

export interface BoundAgentFactory<T extends Agent> {
  /** Construct the agent acting as `principal`. `null` is an anonymous, read-only run (RFC 0029 §1). */
  as(principal: AgentPrincipalInput): BoundAgent<T>
}

/**
 * The `ai` binding. `model()` is the one place a model is resolved: an agent
 * names a provider and never holds a model, which is what lets a fake replace
 * every model an application can reach by replacing this binding. An interface,
 * so a fake implements it rather than subclassing {@link ConfiguredAiManager}.
 */
export interface AiManager {
  readonly config: AiConfig
  agent<T extends Agent>(cls: AgentClass<T>): BoundAgentFactory<T>
  model(provider?: AiProviderName): LanguageModel
  embeddingModel(provider?: AiProviderName): EmbeddingModel
  imageModel(provider?: AiProviderName): ImageModel
  /** Resolves `provider`, then `defaultEvaluation`, then `default`. */
  evaluationModel(provider?: AiProviderName): AiEvaluationModel
  /** The store `config/ai.ts` configures; throws when it configures none. */
  conversations(): ConversationStore
}

type ModelKind = 'model' | 'embeddingModel' | 'imageModel' | 'evaluationModel'

export class ConfiguredAiManager implements AiManager {
  private readonly models = new Map<string, LanguageModel>()
  private readonly embeddingModels = new Map<string, EmbeddingModel>()
  private readonly imageModels = new Map<string, ImageModel>()
  private readonly evaluationModels = new Map<string, AiEvaluationModel>()
  private conversationStore?: ConversationStore

  constructor(
    readonly config: AiConfig,
    private readonly container: Container,
  ) {}

  agent<T extends Agent>(cls: AgentClass<T>): BoundAgentFactory<T> {
    return {
      as: (principal) => bindAgent(cls, principal, { container: this.container, manager: this }),
    }
  }

  model(provider?: AiProviderName): LanguageModel {
    return this.resolve(this.models, 'model', provider)
  }

  embeddingModel(provider?: AiProviderName): EmbeddingModel {
    return this.resolve(this.embeddingModels, 'embeddingModel', provider)
  }

  imageModel(provider?: AiProviderName): ImageModel {
    return this.resolve(this.imageModels, 'imageModel', provider)
  }

  evaluationModel(provider?: AiProviderName): AiEvaluationModel {
    return this.resolve(this.evaluationModels, 'evaluationModel', provider ?? this.config.defaultEvaluation)
  }

  conversations(): ConversationStore {
    if (!this.config.conversations) {
      throw new Error(
        'config/ai.ts configures no conversation store. Add `conversations: { driver: \'database\', conversations, messages }` '
        + '(the tables guren add ai scaffolds), or `{ driver: \'memory\' }` for development.',
      )
    }
    return (this.conversationStore ??= createConversationStore(this.config.conversations))
  }

  /** Every kind is one a provider may leave out; the kind names itself in the error. */
  private resolve<T>(cache: Map<string, T>, kind: ModelKind, provider?: AiProviderName): T {
    const name = provider ?? this.config.default
    return memoize(cache, name, () => {
      const factory = this.provider(name)[kind]
      if (!factory) {
        throw new Error(`The AI provider "${name}" configures no ${kind} in config/ai.ts.`)
      }
      return factory() as T
    })
  }

  private provider(name: string): AiProviderConfig {
    if (!Object.hasOwn(this.config.providers, name)) {
      throw new Error(
        `No AI provider named "${name}" is configured. config/ai.ts configures: `
        + `${describeNames(Object.keys(this.config.providers))}.`,
      )
    }
    return this.config.providers[name]!
  }
}

function memoize<T>(cache: Map<string, T>, key: string, build: () => T): T {
  const hit = cache.get(key)
  if (hit !== undefined) return hit
  const built = build()
  cache.set(key, built)
  return built
}
