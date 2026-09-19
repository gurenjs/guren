/**
 * `embed()` / `embedMany()` / `image()` / `evaluate()` (RFC 0029 Part 3): the AI SDK's
 * own calls with the model resolved by provider *name* through {@link AiManager}, the
 * one resolution point. An application never holds a model, so `fakeAi()` replacing
 * the `ai` binding answers these as it answers a prompt. Every other option is
 * the SDK's, passed through unread.
 */
import { embed as sdkEmbed, embedMany as sdkEmbedMany, experimental_evaluate, generateImage } from 'ai'
import type { EmbedManyResult, EmbedResult, GenerateImageResult } from 'ai'

import { ambientManager } from './ambient'
import type { AiManager } from './manager'
import type { AiEvaluationQuestions, AiEvaluationResult, AiProviderName } from './types'

export interface ModelResolution {
  /** A provider name from `config/ai.ts`; its `default` when absent (`defaultEvaluation` first, for `evaluate()`). */
  provider?: AiProviderName
  /** The manager to resolve the model from; the default application's `ai` binding when absent. */
  manager?: AiManager
}

// `_internal` is the SDK's own test seam ("may change without notice"), so it is
// not re-published here; `model` is what the provider name replaces.
type SdkOptions<T> = Omit<T, 'model' | '_internal'>

export type EmbedOptions = SdkOptions<Parameters<typeof sdkEmbed>[0]> & ModelResolution
export type EmbedManyOptions = SdkOptions<Parameters<typeof sdkEmbedMany>[0]> & ModelResolution
export type ImageOptions = SdkOptions<Parameters<typeof generateImage>[0]> & ModelResolution
export type EvaluateOptions<Q extends AiEvaluationQuestions> = SdkOptions<Parameters<typeof experimental_evaluate<Q>>[0]> & ModelResolution

// `async`, so an unconfigured provider rejects rather than throwing synchronously out of
// a call the caller is awaiting.
export async function embed({ provider, manager, ...options }: EmbedOptions): Promise<EmbedResult> {
  return sdkEmbed({ ...options, model: resolve('embed()', manager).embeddingModel(provider) })
}

export async function embedMany({ provider, manager, ...options }: EmbedManyOptions): Promise<EmbedManyResult> {
  return sdkEmbedMany({ ...options, model: resolve('embedMany()', manager).embeddingModel(provider) })
}

export async function image({ provider, manager, ...options }: ImageOptions): Promise<GenerateImageResult> {
  return generateImage({ ...options, model: resolve('image()', manager).imageModel(provider) })
}

/**
 * Typed questions against one state, answered with probabilities. The SDK's
 * `experimental_evaluate`: experimental upstream, changeable in a patch release of `ai`.
 */
export async function evaluate<const Q extends AiEvaluationQuestions>({ provider, manager, ...options }: EvaluateOptions<Q>): Promise<AiEvaluationResult<Q>> {
  return experimental_evaluate({ ...options, model: resolve('evaluate()', manager).evaluationModel(provider) })
}

function resolve(caller: string, manager: AiManager | undefined): AiManager {
  return manager ?? ambientManager(caller, 'pass { manager }')
}
