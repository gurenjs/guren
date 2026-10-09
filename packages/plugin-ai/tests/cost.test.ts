import { describe, expect, test } from 'bun:test'

import { addUsage, computeCostUsd, usageOf } from '../src'

const usage = {
  inputTokens: 10,
  inputTokenDetails: { noCacheTokens: 4, cacheReadTokens: 5, cacheWriteTokens: 1 },
  outputTokens: 2,
  outputTokenDetails: { textTokens: 2, reasoningTokens: 0 },
  totalTokens: 12,
}

const searched = (id: string) => ({ type: 'tool-call', toolCallId: id, toolName: 'web_search', providerExecuted: true })

describe('usageOf', () => {
  test('should count provider-executed calls by tool name, leaving out the ones that errored', () => {
    const steps = [
      { content: [searched('a'), searched('b'), { type: 'tool-call', toolCallId: 'f', toolName: 'web_fetch', providerExecuted: true }] },
      {
        content: [
          searched('c'),
          { type: 'tool-error', toolCallId: 'c', toolName: 'web_search', providerExecuted: true },
          // An application tool runs in-process and costs nothing per call.
          { type: 'tool-call', toolCallId: 'local', toolName: 'lookup' },
        ],
      },
    ]

    expect(usageOf({ usage, steps })).toEqual({
      inputTokens: 10,
      noCacheInputTokens: 4,
      cacheReadTokens: 5,
      cacheWriteTokens: 1,
      outputTokens: 2,
      totalTokens: 12,
      serverToolRequests: { web_search: 2, web_fetch: 1 },
    })
  })

  test('should read a single step, and leave serverToolRequests out when there were none', () => {
    expect(usageOf({ usage, content: [searched('a')] }).serverToolRequests).toEqual({ web_search: 1 })
    expect(usageOf({ usage: { ...usage, inputTokens: undefined }, steps: [] })).not.toHaveProperty('serverToolRequests')
    expect(usageOf({ usage: { ...usage, inputTokens: undefined }, steps: [] })).not.toHaveProperty('inputTokens')
  })
})

describe('addUsage', () => {
  test('should sum the tokens and merge the request counts', () => {
    expect(addUsage(
      { inputTokens: 3, serverToolRequests: { web_search: 2 } },
      { inputTokens: 4, outputTokens: 1, serverToolRequests: { web_search: 1, web_fetch: 3 } },
    )).toEqual({ inputTokens: 7, outputTokens: 1, serverToolRequests: { web_search: 3, web_fetch: 3 } })
    expect(addUsage({ inputTokens: 1 }, {})).toEqual({ inputTokens: 1 })
  })
})

describe('computeCostUsd', () => {
  test('should charge a priced server tool per thousand calls, and an unpriced one nothing', () => {
    const pricing = { input: 2, output: 10, perThousandRequests: { web_search: 10 } }
    const counted = { noCacheInputTokens: 1_000, outputTokens: 100, serverToolRequests: { web_search: 3, web_fetch: 5 } }

    expect(computeCostUsd(counted, pricing)).toBeCloseTo((1_000 * 2 + 100 * 10) / 1_000_000 + 3 * 10 / 1_000, 12)
  })

  test('should price a response read through usageOf, its server tools included', () => {
    const response = { usage, steps: [{ content: [searched('a')] }] }

    expect(computeCostUsd(usageOf(response), { input: 1, output: 1, perThousandRequests: { web_search: 1_000 } }))
      .toBeCloseTo((4 + 5 + 1 + 2) / 1_000_000 + 1, 12)
  })
})
