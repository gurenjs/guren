import { describe, expect, it, vi, beforeEach } from 'vitest'

const { eventManager, createEventManager, createMailManager, setMailManager, setQueueDriver, registerJob } = vi.hoisted(
  () => {
    const eventManager = { on: vi.fn() }
    return {
      eventManager,
      createEventManager: vi.fn(() => eventManager),
      createMailManager: vi.fn(() => ({ id: 'mail' })),
      setMailManager: vi.fn(),
      setQueueDriver: vi.fn(),
      registerJob: vi.fn(),
    }
  },
)

vi.mock('@guren/server', () => ({
  createEventManager,
  createMailManager,
  setMailManager,
  setQueueDriver,
  registerJob,
  MemoryDriver: class {},
  Event: class {},
  Listener: class {},
  Job: class {},
  AuthenticatableModel: class {},
}))

import { getEventManager, initializeEventSystem } from '../../app/Providers/EventServiceProvider.js'

describe('EventServiceProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('initializes the event system once', () => {
    const first = initializeEventSystem()
    const second = getEventManager()

    expect(first).toBe(second)
    expect(createEventManager).toHaveBeenCalledTimes(1)
    expect(setMailManager).toHaveBeenCalled()
    expect(setQueueDriver).toHaveBeenCalled()
    expect(registerJob).toHaveBeenCalled()
    expect(eventManager.on).toHaveBeenCalled()
  })
})
