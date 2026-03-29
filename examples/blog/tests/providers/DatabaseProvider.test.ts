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
    const provider = new DatabaseProvider({} as never)

    await provider.boot()
    await provider.boot()

    expect(bootModelsMock).toHaveBeenCalledTimes(1)
  })
})
