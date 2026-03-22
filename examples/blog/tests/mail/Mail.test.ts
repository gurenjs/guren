import { describe, expect, it, vi, beforeEach } from 'vitest'

const { mailChain, mail, manager } = vi.hoisted(() => {
  const mailChain = {
    to: vi.fn().mockReturnThis(),
    subject: vi.fn().mockReturnThis(),
    html: vi.fn().mockReturnThis(),
    text: vi.fn().mockReturnThis(),
    send: vi.fn(),
  }

  return {
    manager: { id: 'mailer' },
    mailChain,
    mail: vi.fn(() => mailChain),
  }
})

vi.mock('@guren/core', () => ({
  mail,
}))

import { sendWelcomeMail } from '../../app/Mail/WelcomeMail.js'
import { sendNewPostMail } from '../../app/Mail/NewPostMail.js'

describe('mail helpers', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('sends welcome and post notifications with the injected manager', async () => {
    await sendWelcomeMail(manager as any, { id: 1, name: 'Ada', email: 'ada@example.com' } as any)
    await sendNewPostMail(
      manager as any,
      { email: 'sam@example.com', name: 'Sam' },
      { id: 1, title: 'Hello', body: 'Body' } as any,
      { id: 2, name: 'Ada' } as any,
    )

    expect(mail).toHaveBeenCalledWith(manager)
    expect(mailChain.send).toHaveBeenCalled()
  })
})
