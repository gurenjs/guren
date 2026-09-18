/**
 * Cost and usage arithmetic (RFC 0029 §10). The runner computes cost, never a reporter,
 * so every reporter sees the same number; a provider with no `pricing` yields a row with
 * no cost rather than a zero, which is why every result here is `number | undefined`.
 */
import type { LanguageModelUsage } from 'ai'

import type { EvalUsage } from './eval-types'
import type { AiPricing } from './types'

const PER_MILLION = 1_000_000

export function toEvalUsage(usage: LanguageModelUsage): EvalUsage {
  return stripUndefined({
    inputTokens: usage.inputTokens,
    noCacheInputTokens: usage.inputTokenDetails?.noCacheTokens,
    cacheReadTokens: usage.inputTokenDetails?.cacheReadTokens,
    cacheWriteTokens: usage.inputTokenDetails?.cacheWriteTokens,
    outputTokens: usage.outputTokens,
    totalTokens: usage.totalTokens,
  })
}

export function addUsage(left: EvalUsage, right: EvalUsage): EvalUsage {
  const keys = ['inputTokens', 'noCacheInputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'outputTokens', 'totalTokens'] as const
  const sum: EvalUsage = {}
  for (const key of keys) {
    const a = left[key]
    const b = right[key]
    if (a === undefined && b === undefined) continue
    sum[key] = (a ?? 0) + (b ?? 0)
  }
  return sum
}

/**
 * USD for one call's tokens. A cached read or write with no price of its own is charged at
 * the input rate: that over-states rather than under-states, and a silent zero for cached
 * traffic is what makes one variant look cheaper than it is.
 */
export function computeCostUsd(usage: EvalUsage, pricing: AiPricing | undefined): number | undefined {
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
  return (input + output) / PER_MILLION
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

function stripUndefined(usage: EvalUsage): EvalUsage {
  const kept: EvalUsage = {}
  for (const [key, value] of Object.entries(usage)) {
    if (value !== undefined) kept[key as keyof EvalUsage] = value
  }
  return kept
}
