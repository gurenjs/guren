import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import { Application } from '../../src/http/Application'
import { createContainer, getContainer, setContainer } from '../../src/container/Container'
import {
  defaultApplication,
  defaultContainer,
  resetDefaultApplication,
  useAsDefaultApplication,
} from '../../src/http/default-application'
import { resetWarnOnce } from '../../src/support/warn-once'

describe('the default application', () => {
  let warn: ReturnType<typeof spyOn>

  beforeEach(() => {
    resetDefaultApplication()
    resetWarnOnce()
    warn = spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    warn.mockRestore()
    resetDefaultApplication()
    resetWarnOnce()
  })

  it('is null, and its container unavailable, before any Application exists', () => {
    expect(defaultApplication()).toBeNull()
    expect(() => defaultContainer()).toThrow('Container not initialized')
  })

  it('is the Application most recently constructed, unbooted included', () => {
    const app = new Application()

    expect(defaultApplication()).toBe(app)
    expect(defaultContainer()).toBe(app.container)
    expect(getContainer()).toBe(app.container)
    expect(warn).not.toHaveBeenCalled()
  })

  it('warns once on the first ambient call after a second Application is constructed', () => {
    new Application()
    const second = new Application()
    expect(warn).not.toHaveBeenCalled()

    expect(defaultContainer()).toBe(second.container)
    expect(defaultApplication()).toBe(second)

    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0]?.[0])).toContain('useAsDefaultApplication(app)')
  })

  it('stops warning once an application is chosen explicitly', () => {
    const first = new Application()
    new Application()

    useAsDefaultApplication(first)

    expect(defaultApplication()).toBe(first)
    expect(defaultContainer()).toBe(first.container)
    expect(warn).not.toHaveBeenCalled()
  })

  it('reports no application once a bare container took the ambient slot', () => {
    const app = new Application()
    const bare = createContainer()

    setContainer(bare)

    expect(defaultApplication()).toBeNull()
    expect(defaultContainer()).toBe(bare)
    expect(app.container).not.toBe(bare)
  })

  it('does not count a construction that replaces a displaced default as ambiguous', () => {
    new Application()
    setContainer(createContainer())

    new Application()
    defaultContainer()

    expect(warn).not.toHaveBeenCalled()
  })
})
