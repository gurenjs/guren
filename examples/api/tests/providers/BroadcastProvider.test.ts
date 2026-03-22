import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Container } from '@guren/core'

const { broadcastManager, createBroadcastManager, MemoryBroadcastDriver } = vi.hoisted(() => ({
  broadcastManager: { channel: vi.fn(), privateChannel: vi.fn() },
  createBroadcastManager: vi.fn(() => ({ channel: vi.fn(), privateChannel: vi.fn() })),
  MemoryBroadcastDriver: class MemoryBroadcastDriver {},
}))

vi.mock('@guren/core', async () => {
  const actual = await vi.importActual<typeof import('@guren/core')>('@guren/core')
  return {
    ...actual,
    createBroadcastManager,
    MemoryBroadcastDriver,
  }
})

import BroadcastProvider from '../../app/Providers/BroadcastProvider.js'

describe('API BroadcastProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    createBroadcastManager.mockReturnValue(broadcastManager)
  })

  it('registers a broadcast manager and wires public/private channels', () => {
    const container = new Container()
    const provider = new BroadcastProvider(container)

    provider.register()
    provider.boot()

    expect(createBroadcastManager).toHaveBeenCalledWith({
      default: 'memory',
      drivers: {
        memory: expect.any(Function),
      },
    })
    const [config] = createBroadcastManager.mock.calls[0] as unknown as [{
      default: string
      drivers: { memory: () => unknown }
    }]
    expect(config.drivers.memory()).toBeInstanceOf(MemoryBroadcastDriver)
    expect(container.make('broadcast')).toBe(broadcastManager)
    expect(broadcastManager.channel).toHaveBeenCalledWith('tasks', expect.any(Function))
    expect(broadcastManager.privateChannel).toHaveBeenCalledWith('users.{id}.tasks', expect.any(Function))
  })
})
