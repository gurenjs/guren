import { describe, expect, it } from 'vitest'
import { FakeMail, FakeMailTransport } from './mail'

describe('FakeMailTransport', () => {
  it('records sent messages', async () => {
    const transport = new FakeMailTransport()

    const result = await transport.send({
      to: [{ email: 'jane@example.com' }],
      subject: 'Hello',
      text: 'Hi there',
    })

    expect(result.success).toBe(true)
    expect(transport.getMails()).toHaveLength(1)
  })
})

describe('FakeMail', () => {
  it('asserts sent mail details', () => {
    const fake = new FakeMail()

    fake.record({
      to: [{ email: 'sam@example.com' }],
      from: { email: 'noreply@example.com' },
      subject: 'Welcome',
      html: '<p>Welcome</p>',
      attachments: [{ filename: 'guide.pdf', content: 'data' }],
      cc: [{ email: 'cc@example.com' }],
      bcc: [{ email: 'bcc@example.com' }],
    })

    expect(() => fake.assertSent()).not.toThrow()
    expect(() => fake.assertSentTo('sam@example.com')).not.toThrow()
    expect(() => fake.assertSentFrom('noreply@example.com')).not.toThrow()
    expect(() => fake.assertSentWithSubject('Welcome')).not.toThrow()
    expect(() => fake.assertSentWithBodyContaining('Welcome')).not.toThrow()
    expect(() => fake.assertSentWithAttachment('guide.pdf')).not.toThrow()
    expect(() => fake.assertSentWithCc('cc@example.com')).not.toThrow()
    expect(() => fake.assertSentWithBcc('bcc@example.com')).not.toThrow()
  })
})
