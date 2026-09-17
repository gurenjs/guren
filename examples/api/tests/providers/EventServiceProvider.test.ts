import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Container } from '@guren/core'

const { eventManager, createEventManager, registerJob } = vi.hoisted(() => {
  const eventManager = { on: vi.fn(), listen: vi.fn() }
  return {
    eventManager,
    createEventManager: vi.fn(() => eventManager),
    registerJob: vi.fn(),
  }
})

vi.mock('@guren/core', async () => {
  const actual = await vi.importActual<typeof import('@guren/core')>('@guren/core')
  return {
    ...actual,
    createEventManager,
    registerJob,
  }
})

import EventServiceProvider from '../../app/Providers/EventServiceProvider.js'

describe('API EventServiceProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('binds one event manager and wires the jobs and listeners at boot', () => {
    const container = new Container()
    container.instance('notifications', { registerChannel: vi.fn() })
    container.instance('broadcast', { broadcast: vi.fn() })
    container.instance('storage', { disk: vi.fn(() => ({ put: vi.fn() })) })
    const provider = new EventServiceProvider(container)

    provider.register()
    expect(container.make('events')).toBe(container.make('events'))

    provider.boot()

    expect(createEventManager).toHaveBeenCalledTimes(1)
    expect(registerJob).toHaveBeenCalled()
    expect(eventManager.listen).toHaveBeenCalled()
    expect(eventManager.on).toHaveBeenCalled()
  })
})
