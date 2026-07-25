import { describe, expect, it, vi } from 'vitest'

vi.mock('@guren/core', () => ({
  Job: class {
    protected make() {
      return { id: 'mailer' }
    }
  },
}))

const { sendPasswordResetMailMock } = vi.hoisted(() => ({
  sendPasswordResetMailMock: vi.fn(),
}))

vi.mock('../../app/Mail/PasswordResetMail.js', () => ({
  sendPasswordResetMail: sendPasswordResetMailMock,
}))

import { SendPasswordResetEmailJob } from '../../app/Jobs/SendPasswordResetEmailJob.js'

describe('SendPasswordResetEmailJob', () => {
  it('sends the password reset email', async () => {
    const job = new SendPasswordResetEmailJob()
    await job.handle({ email: 'ada@example.com', resetUrl: 'https://blog.test/reset-password?token=abc' })

    expect(sendPasswordResetMailMock).toHaveBeenCalledWith(
      { id: 'mailer' },
      'ada@example.com',
      'https://blog.test/reset-password?token=abc',
    )
  })
})
