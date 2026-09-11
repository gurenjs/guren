/**
 * The one claim a long-lived process cannot make: on workerd a log channel's
 * write still in flight when the response is produced is abandoned with the
 * request context, silently, so `bun test` completes it and proves nothing.
 */
import { describe, expect, test } from 'bun:test'

import { runDeferralCase, workerdEnabled } from '../agent/workerd-deferral'

describe.skipIf(!workerdEnabled)('an async log channel inside workerd', () => {
  test('should lose an undeferred write and land a deferred one', async () => {
    const entry = new URL('./logger.worker.ts', import.meta.url).pathname
    const landed = await runDeferralCase(entry, 'logged', {
      cases: ['tool=undeferred&defer=0', 'tool=deferred&defer=1', 'tool=held&defer=0'],
    })

    // `held` is the control: the same undeferred write lands while its handler
    // is still running, so a missing `undeferred` is the context closing.
    expect(landed).toEqual(['deferred', 'held'])
  }, 60_000)
})
