/**
 * The one claim a long-lived process cannot make: on workerd an audit write
 * still in flight when the response is produced is abandoned with the request
 * context, silently, so `bun test` completes it and proves nothing.
 */
import { describe, expect, test } from 'bun:test'

import { runDeferralCase, workerdEnabled } from './workerd-deferral'

describe.skipIf(!workerdEnabled)('the audit emitter inside workerd', () => {
  test('should lose an undeferred sink write and land a deferred one', async () => {
    const entry = new URL('./audit-emitter.worker.ts', import.meta.url).pathname
    expect(await runDeferralCase(entry, 'audit')).toEqual(['deferred'])
  }, 60_000)
})
