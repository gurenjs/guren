import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Container } from '@guren/core'

const { storageManager, createStorageManager } = vi.hoisted(() => ({
  storageManager: { disk: vi.fn() },
  createStorageManager: vi.fn(() => ({ disk: vi.fn() })),
}))

vi.mock('@guren/core', async () => {
  const actual = await vi.importActual<typeof import('@guren/core')>('@guren/core')
  return {
    ...actual,
    createStorageManager,
  }
})

import StorageProvider from '../../app/Providers/StorageProvider.js'

describe('API StorageProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    createStorageManager.mockReturnValue(storageManager)
  })

  it('registers a storage manager with local and public disks', () => {
    const container = new Container()
    const provider = new StorageProvider(container)

    provider.register()

    expect(container.make('storage')).toBe(storageManager)
    expect(createStorageManager).toHaveBeenCalledWith({
      default: 'local',
      disks: {
        local: { driver: 'local', root: './storage/app' },
        public: { driver: 'local', root: './storage/app/public' },
      },
    })
  })
})
