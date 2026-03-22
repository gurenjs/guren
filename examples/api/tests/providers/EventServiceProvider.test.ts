import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Container } from '@guren/core'

const {
  eventManager,
  queueManager,
  createEventManager,
  createMailManager,
  createQueueManager,
  setMailManager,
  registerJob,
} = vi.hoisted(() => {
  const eventManager = { on: vi.fn() }
  const queueManager = { driver: vi.fn() }
  return {
    eventManager,
    queueManager,
    createEventManager: vi.fn(() => eventManager),
    createMailManager: vi.fn(() => ({ id: 'mail' })),
    createQueueManager: vi.fn(() => queueManager),
    setMailManager: vi.fn(),
    registerJob: vi.fn(),
  }
})

vi.mock('@guren/core', async () => {
  const actual = await vi.importActual<typeof import('@guren/core')>('@guren/core')
  return {
    ...actual,
    createEventManager,
    createMailManager,
    createQueueManager,
    setMailManager,
    registerJob,
    MemoryDriver: class {},
  }
})

import EventServiceProvider from '../../app/Providers/EventServiceProvider.js'

describe('API EventServiceProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('initializes the event system once and wires queue/mail listeners', () => {
    const container = new Container()
    container.instance('notifications', { registerChannel: vi.fn() })
    container.instance('broadcast', { broadcast: vi.fn() })
    container.instance('storage', { disk: vi.fn(() => ({ put: vi.fn() })) })
    const provider = new EventServiceProvider(container)

    provider.register()
    const first = container.make('events')
    const second = container.make('events')

    expect(first).toBe(second)
    expect(createEventManager).toHaveBeenCalledTimes(1)
    expect(createMailManager).toHaveBeenCalledTimes(1)
    expect(setMailManager).toHaveBeenCalledTimes(1)
    expect(createQueueManager).toHaveBeenCalledTimes(1)
    expect(queueManager.driver).toHaveBeenCalledTimes(1)
    expect(registerJob).toHaveBeenCalled()
    expect(eventManager.on).toHaveBeenCalled()
  })
})
