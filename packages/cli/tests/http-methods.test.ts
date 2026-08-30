import { describe, expect, it } from 'bun:test'
import { describeMethod } from '../src/http-methods'

/**
 * The classification `guren audit`'s two per-route phases and the agent-route
 * input rule all read. Pinned here rather than inside either command's tests,
 * because the whole point of the shared module is that neither owns it.
 */
describe('describeMethod', () => {
  it('classifies the standard verbs', () => {
    expect(describeMethod('GET')).toEqual({ safe: true, bodyCarrying: false })
    expect(describeMethod('HEAD')).toEqual({ safe: true, bodyCarrying: false })
    expect(describeMethod('OPTIONS')).toEqual({ safe: true, bodyCarrying: false })
    expect(describeMethod('POST')).toEqual({ safe: false, bodyCarrying: true })
    expect(describeMethod('PUT')).toEqual({ safe: false, bodyCarrying: true })
    expect(describeMethod('PATCH')).toEqual({ safe: false, bodyCarrying: true })
    expect(describeMethod('DELETE')).toEqual({ safe: false, bodyCarrying: false })
    // The two sets are independent axes, so QUERY (RFC 10008) lands on both:
    // no auth demanded, body validation still checked.
    expect(describeMethod('QUERY')).toEqual({ safe: true, bodyCarrying: true })
  })

  it('is case-insensitive', () => {
    expect(describeMethod('get')).toEqual({ safe: true, bodyCarrying: false })
    expect(describeMethod('delete')).toEqual({ safe: false, bodyCarrying: false })
  })

  it('defaults an unrecognized verb to unsafe and body-carrying', () => {
    expect(describeMethod('PURGE')).toEqual({ safe: false, bodyCarrying: true })
    // TRACE is formally safe per RFC 9110, but the classification leaves it
    // to the fail-closed default on purpose — this pin records that decision.
    expect(describeMethod('TRACE')).toEqual({ safe: false, bodyCarrying: true })
  })
})
