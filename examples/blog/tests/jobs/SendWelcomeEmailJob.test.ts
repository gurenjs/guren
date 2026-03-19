import { describe, expect, it, vi } from 'vitest'

vi.mock('@guren/server', () => ({
  Job: class {},
}))

const { userFindMock, sendWelcomeMailMock } = vi.hoisted(() => ({
  userFindMock: vi.fn(),
  sendWelcomeMailMock: vi.fn(),
}))
vi.mock('../../app/Models/User.js', () => ({
  User: { find: userFindMock },
}))

vi.mock('../../app/Mail/WelcomeMail.js', () => ({
  sendWelcomeMail: sendWelcomeMailMock,
}))

import { SendWelcomeEmailJob } from '../../app/Jobs/SendWelcomeEmailJob.js'

describe('SendWelcomeEmailJob', () => {
  it('skips when the user is missing', async () => {
    userFindMock.mockResolvedValue(null)

    const job = new SendWelcomeEmailJob()
    await job.handle({ userId: 1 })

    expect(sendWelcomeMailMock).not.toHaveBeenCalled()
  })

  it('sends a welcome email when the user exists', async () => {
    userFindMock.mockResolvedValue({ id: 1, email: 'ada@example.com' })

    const job = new SendWelcomeEmailJob()
    await job.handle({ userId: 1 })

    expect(sendWelcomeMailMock).toHaveBeenCalled()
  })
})
