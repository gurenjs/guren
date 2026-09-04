import { beforeEach, describe, expect, it, vi } from 'vitest'

const { createScheduler } = vi.hoisted(() => ({
  scheduler: { schedule: vi.fn() },
  createScheduler: vi.fn(() => ({ schedule: vi.fn() })),
}))

const registerApiSchedules = vi.hoisted(() => vi.fn())

vi.mock('@guren/core', async () => {
  const actual = await vi.importActual<typeof import('@guren/core')>('@guren/core')
  return {
    ...actual,
    createScheduler,
  }
})

vi.mock('../../app/Console/Kernel.js', () => ({
  registerApiSchedules,
}))

import { getScheduler } from '../../app/Providers/SchedulingProvider.js'

describe('API SchedulingProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('creates the scheduler once and registers API schedules', () => {
    const first = getScheduler()
    const second = getScheduler()

    expect(first).toBe(second)
    expect(createScheduler).toHaveBeenCalledWith({ timezone: 'UTC' })
    expect(createScheduler).toHaveBeenCalledTimes(1)
    expect(registerApiSchedules).toHaveBeenCalledTimes(1)
    expect(registerApiSchedules).toHaveBeenCalledWith(first)
  })
})
