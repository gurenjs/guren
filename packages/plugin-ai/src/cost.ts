/**
 * Cost and usage arithmetic, shared by the eval runner (RFC 0029 §10), which computes cost so
 * that every reporter sees the same number, and by applications recording what a run cost.
 * A provider with no `pricing` yields no cost rather than a zero, which is why every cost here
 * is `number | undefined`.
 */
import type { LanguageModelUsage } from 'ai'

import type { AiPricing, AiUsage } from './types'

const PER_MILLION = 1_000_000
const PER_THOUSAND = 1_000

/** The parts of a step's `content` that `usageOf()` reads; a `StepResult` is one. */
export interface UsageStep {
  readonly content: ReadonlyArray<{ type: string; toolCallId?: string; toolName?: string; providerExecuted?: boolean }>
}

/** What `usageOf()` accepts: an `AgentResponse`, an AI SDK generate result, or one `StepResult`. */
export interface UsageSource {
  readonly usage: LanguageModelUsage
  readonly steps?: ReadonlyArray<UsageStep>
  readonly content?: UsageStep['content']
}

/** Token counts only; {@link usageOf} adds the provider-executed tool calls a response's steps hold. */
export function toEvalUsage(usage: LanguageModelUsage): AiUsage {
  return stripUndefined({
    inputTokens: usage.inputTokens,
    noCacheInputTokens: usage.inputTokenDetails?.noCacheTokens,
    cacheReadTokens: usage.inputTokenDetails?.cacheReadTokens,
    cacheWriteTokens: usage.inputTokenDetails?.cacheWriteTokens,
    outputTokens: usage.outputTokens,
    totalTokens: usage.totalTokens,
  })
}

/**
 * A response's tokens, plus its provider-executed tool calls by tool name. A call whose result
 * is a `tool-error` is not counted: Anthropic bills no web search that errored. Read from the
 * steps rather than a provider's metadata, so no provider package is imported here.
 */
export function usageOf(source: UsageSource): AiUsage {
  const usage = toEvalUsage(source.usage)
  const steps = source.steps ?? (source.content ? [{ content: source.content }] : [])
  const requests = serverToolRequests(steps)
  return requests ? { ...usage, serverToolRequests: requests } : usage
}

export function addUsage(left: AiUsage, right: AiUsage): AiUsage {
  const keys = ['inputTokens', 'noCacheInputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'outputTokens', 'totalTokens'] as const
  const sum: AiUsage = {}
  for (const key of keys) {
    const a = left[key]
    const b = right[key]
    if (a === undefined && b === undefined) continue
    sum[key] = (a ?? 0) + (b ?? 0)
  }
  if (left.serverToolRequests || right.serverToolRequests) {
    const requests: Record<string, number> = { ...left.serverToolRequests }
    for (const [tool, count] of Object.entries(right.serverToolRequests ?? {})) {
      requests[tool] = (requests[tool] ?? 0) + count
    }
    sum.serverToolRequests = requests
  }
  return sum
}

/**
 * USD for one call's tokens and provider-executed tool calls. A cached read or write with no
 * price of its own is charged at the input rate: that over-states rather than under-states,
 * and a silent zero for cached traffic is what makes one variant look cheaper than it is.
 */
export function computeCostUsd(usage: AiUsage, pricing: AiPricing | undefined): number | undefined {
  if (!pricing) return undefined

  const cacheRead = usage.cacheReadTokens ?? 0
  const cacheWrite = usage.cacheWriteTokens ?? 0
  const detailed = usage.noCacheInputTokens !== undefined || cacheRead > 0 || cacheWrite > 0
  const noCache = detailed
    ? usage.noCacheInputTokens ?? Math.max((usage.inputTokens ?? 0) - cacheRead - cacheWrite, 0)
    : usage.inputTokens ?? 0

  const input = noCache * pricing.input
    + cacheRead * (pricing.cacheRead ?? pricing.input)
    + cacheWrite * (pricing.cacheWrite ?? pricing.input)
  const output = (usage.outputTokens ?? 0) * pricing.output
  let requests = 0
  for (const [tool, count] of Object.entries(usage.serverToolRequests ?? {})) {
    requests += count * (pricing.perThousandRequests?.[tool] ?? 0)
  }
  return (input + output) / PER_MILLION + requests / PER_THOUSAND
}

/** Sum of the costs present; `undefined` when none is, so "no pricing" never reads as $0. */
export function sumCosts(costs: ReadonlyArray<number | undefined>): number | undefined {
  let total: number | undefined
  for (const cost of costs) {
    if (cost === undefined) continue
    total = (total ?? 0) + cost
  }
  return total
}

function serverToolRequests(steps: ReadonlyArray<UsageStep>): Record<string, number> | undefined {
  const failed = new Set<string>()
  for (const step of steps) {
    for (const part of step.content) {
      if (part.type === 'tool-error' && part.providerExecuted && part.toolCallId) failed.add(part.toolCallId)
    }
  }
  let requests: Record<string, number> | undefined
  for (const step of steps) {
    for (const part of step.content) {
      if (part.type !== 'tool-call' || !part.providerExecuted || !part.toolName) continue
      if (part.toolCallId && failed.has(part.toolCallId)) continue
      requests ??= {}
      requests[part.toolName] = (requests[part.toolName] ?? 0) + 1
    }
  }
  return requests
}

function stripUndefined(usage: AiUsage): AiUsage {
  const kept: AiUsage = {}
  for (const [key, value] of Object.entries(usage)) {
    if (value !== undefined) (kept as Record<string, unknown>)[key] = value
  }
  return kept
}
