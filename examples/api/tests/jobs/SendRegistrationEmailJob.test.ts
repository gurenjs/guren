import { describe, expect, it, vi } from 'vitest'

vi.mock('@guren/core', () => ({
  Job: class {
    protected make() {
      return { id: 'mailer' }
    }
  },
}))

const { userFindMock, sendRegistrationMailMock } = vi.hoisted(() => ({
  userFindMock: vi.fn(),
  sendRegistrationMailMock: vi.fn(),
}))
vi.mock('../../app/Models/User.js', () => ({
  User: { find: userFindMock },
}))

vi.mock('../../app/Mail/RegistrationMail.js', () => ({
  sendRegistrationMail: sendRegistrationMailMock,
}))

import { SendRegistrationEmailJob } from '../../app/Jobs/SendRegistrationEmailJob.js'

describe('SendRegistrationEmailJob', () => {
  it('skips when the user is missing', async () => {
    userFindMock.mockResolvedValue(null)

    const job = new SendRegistrationEmailJob()
    await job.handle({ userId: 1 })

    expect(sendRegistrationMailMock).not.toHaveBeenCalled()
  })

  it('sends a registration email when the user exists', async () => {
    userFindMock.mockResolvedValue({ id: 1, email: 'ada@example.com', name: 'Ada' })

    const job = new SendRegistrationEmailJob()
    await job.handle({ userId: 1 })

    expect(sendRegistrationMailMock).toHaveBeenCalledWith({ id: 'mailer' }, { email: 'ada@example.com', name: 'Ada' })
  })
})
