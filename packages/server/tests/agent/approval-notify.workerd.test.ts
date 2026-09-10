/**
 * The one claim a long-lived process cannot make: on workerd an approval
 * notification still in flight when the response is produced is abandoned with
 * the request context, silently, so `bun test` completes it and proves nothing.
 */
import { describe, expect, test } from 'bun:test'

import { runDeferralCase, workerdEnabled } from './workerd-deferral'

describe.skipIf(!workerdEnabled)('the approval notification inside workerd', () => {
  test('should lose an undeferred notification and land a deferred one', async () => {
    const entry = new URL('./approval-notify.worker.ts', import.meta.url).pathname
    expect(await runDeferralCase(entry, 'notified')).toEqual(['deferred'])
  }, 60_000)
})
