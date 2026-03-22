import { beforeEach, describe, expect, it, vi } from 'vitest'

const createScheduler = vi.hoisted(() => vi.fn(() => ({ schedule: vi.fn() })))
const registerBlogSchedules = vi.hoisted(() => vi.fn())

vi.mock('@guren/core', async () => {
  const actual = await vi.importActual<typeof import('@guren/core')>('@guren/core')
  return {
    ...actual,
    createScheduler,
  }
})

vi.mock('../../app/Console/Kernel.js', () => ({
  registerBlogSchedules,
}))

import { getScheduler } from '../../app/Providers/SchedulingProvider.js'

describe('Blog SchedulingProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('creates the scheduler once and registers blog schedules', () => {
    const first = getScheduler()
    const second = getScheduler()

    expect(first).toBe(second)
    expect(createScheduler).toHaveBeenCalledWith({ timezone: 'Asia/Tokyo' })
    expect(createScheduler).toHaveBeenCalledTimes(1)
    expect(registerBlogSchedules).toHaveBeenCalledTimes(1)
    expect(registerBlogSchedules).toHaveBeenCalledWith(first)
  })
})
