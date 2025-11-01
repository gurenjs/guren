import { describe, expect, it } from 'bun:test'
import { ViewEngine } from '../../src'

describe('ViewEngine', () => {
  it('registers renderers and delegates rendering', async () => {
    const calls: Array<{ template: string; props: Record<string, unknown> }> = []

    ViewEngine.register('test-engine', (template, props) => {
      calls.push({ template, props })
      return new Response(`${template}:${JSON.stringify(props)}`)
    })

    expect(ViewEngine.has('test-engine')).toBe(true)

    const response = ViewEngine.render('test-engine', 'Dashboard', { users: 2 })

    expect(calls).toEqual([{ template: 'Dashboard', props: { users: 2 } }])
    expect(await response.text()).toBe('Dashboard:{"users":2}')
  })

  it('throws a descriptive error when rendering with an unknown engine', () => {
    expect(() => ViewEngine.render('missing-engine', 'Example', {})).toThrow(
      'View engine "missing-engine" has not been registered.',
    )
  })
})
