import { afterEach, describe, expect, it, spyOn } from 'bun:test'
import { Application } from '../../src/http/Application'
import { MailServiceProvider } from '../../src/providers/MailServiceProvider'
import { createMailManager, mail, type MailManager } from '../../src/mail'

describe('MailServiceProvider', () => {
  const logSpy = spyOn(console, 'log').mockImplementation(() => {})
  afterEach(() => logSpy.mockClear())

  it('binds a manager whose default transport writes to the log, so an unconfigured app can send', async () => {
    const app = new Application({ providers: [MailServiceProvider] })
    await app.boot()

    const manager = app.container.make<MailManager>('mail')
    expect(manager.getDefaultTransportName()).toBe('log')
    expect(manager.transport().name).toBe('log')

    const result = await mail(manager).to('user@example.com').subject('Welcome').text('Hello').send()

    expect(result.success).toBe(true)
    const logged = logSpy.mock.calls.map((call) => String(call[0])).join('\n')
    expect(logged).toContain('[mail] To: user@example.com')
    expect(logged).toContain('[mail] Subject: Welcome')
  })

  it('leaves the smtp default to a manager the app configures itself', () => {
    expect(createMailManager().getDefaultTransportName()).toBe('smtp')
    expect(() => createMailManager().transport()).toThrow('Mail transport not found: smtp')
  })
})
