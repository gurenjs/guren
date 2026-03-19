import { describe, expect, it, vi, beforeEach } from 'vitest'

const { getMailManager, mailChain, mail } = vi.hoisted(() => {
  const mailChain = {
    to: vi.fn().mockReturnThis(),
    subject: vi.fn().mockReturnThis(),
    html: vi.fn().mockReturnThis(),
    text: vi.fn().mockReturnThis(),
    send: vi.fn(),
  }

  return {
    getMailManager: vi.fn(),
    mailChain,
    mail: vi.fn(() => mailChain),
  }
})

vi.mock('@guren/server', () => ({
  getMailManager,
  mail,
}))

import { sendWelcomeMail } from '../../app/Mail/WelcomeMail.js'
import { sendNewPostMail } from '../../app/Mail/NewPostMail.js'

describe('mail helpers', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('logs when mail manager is missing', async () => {
    getMailManager.mockReturnValue(null)

    await sendWelcomeMail({ id: 1, name: 'Ada', email: 'ada@example.com' } as any)

    expect(mail).not.toHaveBeenCalled()
  })

  it('sends welcome and post notifications when manager is available', async () => {
    getMailManager.mockReturnValue({ id: 'mailer' })

    await sendWelcomeMail({ id: 1, name: 'Ada', email: 'ada@example.com' } as any)
    await sendNewPostMail(
      { email: 'sam@example.com', name: 'Sam' },
      { id: 1, title: 'Hello', body: 'Body' } as any,
      { id: 2, name: 'Ada' } as any,
    )

    expect(mail).toHaveBeenCalled()
    expect(mailChain.send).toHaveBeenCalled()
  })
})
