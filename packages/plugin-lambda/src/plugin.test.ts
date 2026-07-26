import { describe, test, expect } from 'bun:test'
import { lambdaPlugin } from './index'

describe('lambdaPlugin', () => {
  test('should return an independent provider class per call', () => {
    const first = lambdaPlugin()
    const second = lambdaPlugin()

    expect(first).not.toBe(second)
    expect(first.name).toBe('lambdaPluginProvider')
  })
})
