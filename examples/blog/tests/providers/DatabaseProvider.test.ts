import { describe, expect, it, vi } from 'vitest'

const { bootModelsMock } = vi.hoisted(() => ({
  bootModelsMock: vi.fn(),
}))
vi.mock('../../config/app.js', () => ({
  bootModels: bootModelsMock,
}))

import DatabaseProvider from '../../app/Providers/DatabaseProvider.js'

describe('DatabaseProvider', () => {
  it('boots models only once', async () => {
    const provider = new DatabaseProvider()

    await provider.boot({} as any)
    await provider.boot({} as any)

    expect(bootModelsMock).toHaveBeenCalledTimes(1)
  })
})
