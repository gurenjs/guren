import { describe, expect, it, spyOn } from 'bun:test'
import { Container } from '../../src/container/Container'
import { LogServiceProvider } from '../../src/providers/LogServiceProvider'
import { getLogManager, type LogManager } from '../../src/logging'

describe('LogServiceProvider', () => {
  it('should bind a log manager whose default channel writes to the console', () => {
    const container = new Container()
    new LogServiceProvider(container).register()
    const log = container.make<LogManager>('log')

    const info = spyOn(console, 'info').mockImplementation(() => {})
    try {
      expect(() => log.channel()).not.toThrow()
      log.info('booted')
      expect(info).toHaveBeenCalledTimes(1)
      expect(String(info.mock.calls[0]?.[0])).toContain('booted')
    } finally {
      info.mockRestore()
    }
  })

  it('should publish the bound manager as the global one at boot', () => {
    const container = new Container()
    const provider = new LogServiceProvider(container)
    provider.register()
    provider.boot()

    expect(getLogManager()).toBe(container.make<LogManager>('log'))
  })
})
