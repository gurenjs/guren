import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  MailManager,
  createMailManager,
  Mail,
  mail,
  MemoryTransport,
  setMailManager,
} from '../../src/mail'
import {
  setQueueDriver,
  MemoryDriver,
  clearJobRegistry,
} from '../../src/queue'

describe('MemoryTransport', () => {
  let transport: MemoryTransport

  beforeEach(() => {
    transport = new MemoryTransport()
  })

  it('stores sent messages', async () => {
    const result = await transport.send({
      from: { email: 'sender@example.com' },
      to: [{ email: 'recipient@example.com' }],
      subject: 'Test',
      text: 'Hello',
    })

    expect(result.success).toBe(true)
    expect(result.messageId).toBeDefined()
    expect(transport.count()).toBe(1)
  })

  it('retrieves last message', async () => {
    await transport.send({
      from: { email: 'sender@example.com' },
      to: [{ email: 'recipient@example.com' }],
      subject: 'First',
      text: 'Hello',
    })

    await transport.send({
      from: { email: 'sender@example.com' },
      to: [{ email: 'recipient@example.com' }],
      subject: 'Second',
      text: 'World',
    })

    const last = transport.getLastMessage()
    expect(last?.subject).toBe('Second')
  })

  it('finds messages by recipient', async () => {
    await transport.send({
      from: { email: 'sender@example.com' },
      to: [{ email: 'user1@example.com' }],
      subject: 'Test 1',
      text: 'Hello',
    })

    await transport.send({
      from: { email: 'sender@example.com' },
      to: [{ email: 'user2@example.com' }],
      subject: 'Test 2',
      text: 'World',
    })

    const messages = transport.findByRecipient('user1@example.com')
    expect(messages).toHaveLength(1)
    expect(messages[0].subject).toBe('Test 1')
  })

  it('finds messages by subject', async () => {
    await transport.send({
      from: { email: 'sender@example.com' },
      to: [{ email: 'user@example.com' }],
      subject: 'Welcome to our app',
      text: 'Hello',
    })

    await transport.send({
      from: { email: 'sender@example.com' },
      to: [{ email: 'user@example.com' }],
      subject: 'Password reset',
      text: 'Click here',
    })

    const messages = transport.findBySubject('Welcome')
    expect(messages).toHaveLength(1)
    expect(messages[0].subject).toBe('Welcome to our app')
  })

  it('checks if sent to recipient', async () => {
    await transport.send({
      from: { email: 'sender@example.com' },
      to: [{ email: 'user@example.com' }],
      subject: 'Test',
      text: 'Hello',
    })

    expect(transport.hasSentTo('user@example.com')).toBe(true)
    expect(transport.hasSentTo('other@example.com')).toBe(false)
  })

  it('clears all messages', async () => {
    await transport.send({
      from: { email: 'sender@example.com' },
      to: [{ email: 'user@example.com' }],
      subject: 'Test',
      text: 'Hello',
    })

    expect(transport.count()).toBe(1)
    transport.clear()
    expect(transport.count()).toBe(0)
  })

  it('simulates failures', async () => {
    transport.setSimulateFailure(true, 'SMTP connection failed')

    const result = await transport.send({
      from: { email: 'sender@example.com' },
      to: [{ email: 'user@example.com' }],
      subject: 'Test',
      text: 'Hello',
    })

    expect(result.success).toBe(false)
    expect(result.error).toBe('SMTP connection failed')
  })

  it('provides assertion methods', async () => {
    await transport.send({
      from: { email: 'sender@example.com' },
      to: [{ email: 'user@example.com' }],
      subject: 'Welcome',
      text: 'Hello',
    })

    expect(() => transport.assertSentTo('user@example.com')).not.toThrow()
    expect(() => transport.assertSentWithSubject('Welcome')).not.toThrow()
    expect(() => transport.assertSentCount(1)).not.toThrow()

    expect(() => transport.assertSentTo('other@example.com')).toThrow()
    expect(() => transport.assertSentWithSubject('Goodbye')).toThrow()
    expect(() => transport.assertSentCount(2)).toThrow()
  })
})

describe('MailManager', () => {
  it('creates with default configuration', () => {
    const manager = new MailManager()
    expect(manager.getDefaultTransportName()).toBe('smtp')
  })

  it('uses custom default transport', () => {
    const manager = new MailManager({
      default: 'resend',
    })
    expect(manager.getDefaultTransportName()).toBe('resend')
  })

  it('stores default from address', () => {
    const manager = new MailManager({
      from: { email: 'noreply@example.com', name: 'MyApp' },
    })
    expect(manager.getDefaultFrom()).toEqual({
      email: 'noreply@example.com',
      name: 'MyApp',
    })
  })

  it('registers transports from config', () => {
    const manager = new MailManager({
      transports: {
        memory: {
          driver: 'memory',
        },
      },
    })

    expect(manager.hasTransport('memory')).toBe(true)
    const transport = manager.transport('memory')
    expect(transport).toBeInstanceOf(MemoryTransport)
  })

  it('throws for unknown driver', () => {
    expect(() =>
      new MailManager({
        transports: {
          unknown: {
            driver: 'unknown-driver',
          },
        },
      })
    ).toThrow('Unknown mail driver: unknown-driver')
  })

  it('caches resolved transports', () => {
    const manager = new MailManager({
      transports: {
        memory: { driver: 'memory' },
      },
    })

    const transport1 = manager.transport('memory')
    const transport2 = manager.transport('memory')
    expect(transport1).toBe(transport2)
  })

  it('registers custom transports', () => {
    const manager = new MailManager()
    const customTransport = new MemoryTransport()

    manager.registerTransport('custom', () => customTransport)

    expect(manager.hasTransport('custom')).toBe(true)
    expect(manager.transport('custom')).toBe(customTransport)
  })

  it('lists transport names', () => {
    const manager = new MailManager({
      transports: {
        memory: { driver: 'memory' },
        memory2: { driver: 'memory' },
      },
    })

    const names = manager.getTransportNames()
    expect(names).toContain('memory')
    expect(names).toContain('memory2')
  })
})

describe('createMailManager', () => {
  it('creates a mail manager', () => {
    const manager = createMailManager({
      default: 'memory',
      from: { email: 'test@example.com' },
    })

    expect(manager).toBeInstanceOf(MailManager)
    expect(manager.getDefaultTransportName()).toBe('memory')
  })
})

describe('Mail (fluent builder)', () => {
  let manager: MailManager
  let transport: MemoryTransport

  beforeEach(() => {
    transport = new MemoryTransport()
    manager = new MailManager({
      default: 'memory',
      from: { email: 'default@example.com', name: 'Default Sender' },
    })
    manager.registerTransport('memory', () => transport)
  })

  it('builds and sends email with all fields', async () => {
    const result = await mail(manager)
      .from('custom@example.com')
      .to('recipient@example.com')
      .cc('cc@example.com')
      .bcc('bcc@example.com')
      .replyTo('reply@example.com')
      .subject('Test Subject')
      .text('Hello World')
      .html('<p>Hello World</p>')
      .header('X-Custom', 'value')
      .send()

    expect(result.success).toBe(true)

    const message = transport.getLastMessage()
    expect(message?.from?.email).toBe('custom@example.com')
    expect(message?.to[0].email).toBe('recipient@example.com')
    expect(message?.cc?.[0].email).toBe('cc@example.com')
    expect(message?.bcc?.[0].email).toBe('bcc@example.com')
    expect(message?.replyTo?.email).toBe('reply@example.com')
    expect(message?.subject).toBe('Test Subject')
    expect(message?.text).toBe('Hello World')
    expect(message?.html).toBe('<p>Hello World</p>')
    expect(message?.headers?.['X-Custom']).toBe('value')
  })

  it('rejects header values containing CRLF (header injection)', () => {
    expect(() =>
      mail(manager).header('X-Custom', 'value\r\nBcc: attacker@example.com'),
    ).toThrow('newline')
  })

  it('rejects header names containing CRLF (header injection)', () => {
    expect(() => mail(manager).header('X-Custom\r\nBcc', 'value')).toThrow('newline')
  })

  it('uses default from address', async () => {
    await mail(manager)
      .to('recipient@example.com')
      .subject('Test')
      .text('Hello')
      .send()

    const message = transport.getLastMessage()
    expect(message?.from?.email).toBe('default@example.com')
    expect(message?.from?.name).toBe('Default Sender')
  })

  it('parses string addresses with names', async () => {
    await mail(manager)
      .to('John Doe <john@example.com>')
      .subject('Test')
      .text('Hello')
      .send()

    const message = transport.getLastMessage()
    expect(message?.to[0].email).toBe('john@example.com')
    expect(message?.to[0].name).toBe('John Doe')
  })

  it('adds multiple recipients with toMany', async () => {
    await mail(manager)
      .toMany(['user1@example.com', 'user2@example.com'])
      .subject('Test')
      .text('Hello')
      .send()

    const message = transport.getLastMessage()
    expect(message?.to).toHaveLength(2)
  })

  it('adds attachments', async () => {
    await mail(manager)
      .to('user@example.com')
      .subject('Test')
      .text('Hello')
      .attach({ filename: 'test.txt', content: 'file content' })
      .send()

    const message = transport.getLastMessage()
    expect(message?.attachments).toHaveLength(1)
    expect(message?.attachments?.[0].filename).toBe('test.txt')
  })

  it('uses specific transport via()', async () => {
    const otherTransport = new MemoryTransport()
    manager.registerTransport('other', () => otherTransport)

    await mail(manager)
      .to('user@example.com')
      .subject('Test')
      .text('Hello')
      .via('other')
      .send()

    expect(transport.count()).toBe(0)
    expect(otherTransport.count()).toBe(1)
  })

  it('throws when missing recipient', () => {
    const m = mail(manager).subject('Test').text('Hello')
    expect(() => m.buildMessage()).toThrow('Email must have at least one recipient')
  })

  it('throws when missing subject', () => {
    const m = mail(manager).to('user@example.com').text('Hello')
    expect(() => m.buildMessage()).toThrow('Email must have a subject')
  })

  it('throws when missing body', () => {
    const m = mail(manager).to('user@example.com').subject('Test')
    expect(() => m.buildMessage()).toThrow('Email must have a text or html body')
  })
})

describe('Mail with Queue', () => {
  let manager: MailManager
  let transport: MemoryTransport
  let queueDriver: MemoryDriver

  beforeEach(() => {
    transport = new MemoryTransport()
    manager = new MailManager({
      default: 'memory',
      from: { email: 'default@example.com' },
    })
    manager.registerTransport('memory', () => transport)
    setMailManager(manager)

    queueDriver = new MemoryDriver()
    setQueueDriver(queueDriver)
    clearJobRegistry()
  })

  it('queues email for async sending', async () => {
    const jobId = await mail(manager)
      .to('user@example.com')
      .subject('Queued Email')
      .text('This will be sent via queue')
      .queue('emails')

    expect(jobId).toBeDefined()
    expect(await queueDriver.size('emails')).toBe(1)
    expect(transport.count()).toBe(0)
  })

  it('throws when queue driver not configured', async () => {
    setQueueDriver(null as any)

    await expect(
      mail(manager)
        .to('user@example.com')
        .subject('Test')
        .text('Hello')
        .queue()
    ).rejects.toThrow('Queue driver not configured')
  })
})

describe('mail() helper function', () => {
  it('creates a Mail instance', () => {
    const manager = new MailManager()
    const instance = mail(manager)
    expect(instance).toBeInstanceOf(Mail)
  })
})

// @react-email/render is not installed in this workspace. Stand it in so
// template() gets past the import and the failure under test is the rendering.
let renderStub: (element: unknown) => Promise<string> = async () => '<p>rendered</p>'
vi.mock('@react-email/render', () => ({
  render: (element: unknown) => renderStub(element),
}))

describe('Mail.template', () => {
  let manager: MailManager

  beforeEach(() => {
    manager = new MailManager({
      default: 'memory',
      from: { email: 'default@example.com', name: 'Default Sender' },
    })
    manager.registerTransport('memory', () => new MemoryTransport())
    renderStub = async () => '<p>rendered</p>'
  })

  it('keeps the rendering failure as the cause and names the template', async () => {
    const failure = new Error('render exploded')
    renderStub = async () => {
      throw failure
    }
    function WelcomeEmail(): null {
      return null
    }

    let thrown: unknown
    try {
      await mail(manager).template(WelcomeEmail, {})
    } catch (error) {
      thrown = error
    }

    expect(thrown).toBeInstanceOf(Error)
    const error = thrown as Error
    expect(error.cause).toBe(failure)
    expect(error.message).toContain('WelcomeEmail')
    expect(error.message).toContain('render exploded')
    // The package loaded, so the install hint would send the reader the wrong way.
    expect(error.message).not.toContain('is installed')
  })

  it('keeps a failure thrown by the component itself as the cause', async () => {
    const failure = new Error('missing prop')
    function BrokenEmail(): never {
      throw failure
    }

    let thrown: unknown
    try {
      await mail(manager).template(BrokenEmail, {})
    } catch (error) {
      thrown = error
    }

    expect((thrown as Error).cause).toBe(failure)
    expect((thrown as Error).message).toContain('BrokenEmail')
  })
})
