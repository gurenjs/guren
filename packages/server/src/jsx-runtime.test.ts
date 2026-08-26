import { describe, test, expect } from 'bun:test'
import { jsx, jsxs, Fragment } from './jsx-runtime'
import { jsxDEV } from './jsx-dev-runtime'

describe('jsx runtime subpaths (RFC 0014)', () => {
  test('should re-export hono\'s automatic-runtime surface', () => {
    expect(typeof jsx).toBe('function')
    expect(typeof jsxs).toBe('function')
    expect(typeof jsxDEV).toBe('function')
    expect(typeof Fragment).toBe('function')
  })

  test('should render an escaped element through the re-export', async () => {
    const node = jsx('p', { children: '<x>' }, undefined)
    expect(String(await node.toString())).toBe('<p>&lt;x&gt;</p>')
  })
})
