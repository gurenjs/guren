/**
 * The question #775 and #778 left open: does a Durable Object abandon a side
 * channel its handler left running, the way a fetch handler does? It does not,
 * from any of the four ways an agent's code runs there. That is why
 * `@guren/plugin-agents` builds its audit emitter and approval context with no
 * deferrer, where the App MCP endpoint must pass `waitUntil`.
 */
import { describe, expect, test } from 'bun:test'

import { runDeferralCase, workerdEnabled } from './workerd-deferral'

const ENTRY_POINTS = ['fetch', 'rpc', 'alarm', 'websocket'] as const

describe.skipIf(!workerdEnabled)('an undeferred side channel inside a Durable Object', () => {
  test('should land from every Durable Object entry point while a fetch handler loses it', async () => {
    const entry = new URL('./durable-object.worker.ts', import.meta.url).pathname

    const landed = await runDeferralCase(entry, 'landed', {
      cases: ['handler', ...ENTRY_POINTS].map((via) => `tool=${via}`),
      durableObjects: { PROBE: 'ProbeObject' },
    })

    // `handler` is absent from both halves: the control that shows this run
    // can see a write being dropped at all.
    expect(landed).toEqual(
      ENTRY_POINTS.flatMap((via) => [`audit:${via}`, `notify:${via}`]).sort(),
    )
  }, 60_000)
})
