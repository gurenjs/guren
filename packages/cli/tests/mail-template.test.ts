import { describe, expect, it } from 'bun:test'
import { Container, MemoryTransport, type AppEnv, type MailManager } from '@guren/core'
import { loadConfigTemplate } from './helpers'

const mailConfig = await loadConfigTemplate('mail')

const ENV = {
  MAIL_MAILER: 'memory',
  MAIL_FROM_ADDRESS: 'noreply@example.com',
  MAIL_FROM_NAME: 'Guren',
  SMTP_HOST: 'localhost',
  SMTP_PORT: 587,
} as unknown as AppEnv

// The template itself: scaffold-output.test.ts pins the written file byte-identical to it.
describe('scaffolded mail config definition', () => {
  it('binds a manager on the transport MAIL_MAILER names', () => {
    const container = new Container()
    mailConfig.bind(container, mailConfig.resolve(ENV))

    expect(container.make<MailManager>('mail').transport()).toBeInstanceOf(MemoryTransport)
  })

  it('sends SMTP credentials only when SMTP_USER is set', () => {
    expect(mailConfig.resolve(ENV).transports?.smtp).toMatchObject({ host: 'localhost', port: 587, auth: undefined })
    expect(mailConfig.resolve({ ...ENV, SMTP_USER: 'ada', SMTP_PASS: 'secret' } as AppEnv).transports?.smtp)
      .toMatchObject({ auth: { user: 'ada', pass: 'secret' } })
  })

  // The manager accepts any name and throws only on the first send; an inherited
  // property name (`toString`) must not pass for a declared transport either.
  for (const name of ['sendgrid', 'toString']) {
    it(`refuses MAIL_MAILER=${name} at resolve`, () => {
      expect(() => mailConfig.resolve({ ...ENV, MAIL_MAILER: name } as AppEnv)).toThrow(`MAIL_MAILER="${name}" is not a declared transport`)
    })
  }
})
