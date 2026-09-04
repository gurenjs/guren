import type { MailMessage, SendResult, MailTransport } from '@guren/server'

/**
 * Recorded mail for testing.
 */
export interface RecordedMail {
  message: MailMessage
  timestamp: Date
}

/**
 * Fake mail transport for testing.
 */
export class FakeMailTransport implements MailTransport {
  readonly name = 'fake'
  private mails: RecordedMail[] = []

  async send(message: MailMessage): Promise<SendResult> {
    this.mails.push({
      message,
      timestamp: new Date(),
    })

    return {
      success: true,
      messageId: `fake-mail-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    }
  }

  /**
   * Get all recorded mails.
   */
  getMails(): RecordedMail[] {
    return [...this.mails]
  }

  /**
   * Clear recorded mails.
   */
  clear(): void {
    this.mails = []
  }
}

/**
 * Fake mail for testing mail sending.
 */
export class FakeMail {
  private transport: FakeMailTransport

  constructor() {
    this.transport = new FakeMailTransport()
  }

  /**
   * Get the underlying transport.
   */
  getTransport(): FakeMailTransport {
    return this.transport
  }

  /**
   * Record a mail send.
   */
  record(message: MailMessage): void {
    void this.transport.send(message)
  }

  /**
   * Assert a mail was sent.
   */
  assertSent(callback?: (message: MailMessage) => boolean): void {
    const mails = this.transport.getMails()

    if (mails.length === 0) {
      throw new Error('Expected a mail to be sent')
    }

    if (callback) {
      const match = mails.some((m) => callback(m.message))
      if (!match) {
        throw new Error('Expected a mail to match callback, but none did')
      }
    }
  }

  /**
   * Assert a mail was sent a specific number of times.
   */
  assertSentTimes(times: number): void {
    const mails = this.transport.getMails()

    if (mails.length !== times) {
      throw new Error(
        `Expected ${times} mails to be sent, got ${mails.length}`
      )
    }
  }

  /**
   * Assert no mails were sent.
   */
  assertNothingSent(): void {
    const mails = this.transport.getMails()

    if (mails.length > 0) {
      throw new Error(
        `Expected no mails to be sent, but ${mails.length} were sent`
      )
    }
  }

  /**
   * Assert a mail was sent to a specific address.
   */
  assertSentTo(address: string): void {
    const mails = this.transport.getMails()
    const match = mails.some((m) => {
      return m.message.to.some((addr) => addr.email === address)
    })

    if (!match) {
      throw new Error(`Expected a mail to be sent to [${address}]`)
    }
  }

  /**
   * Assert a mail was sent from a specific address.
   */
  assertSentFrom(address: string): void {
    const mails = this.transport.getMails()
    const match = mails.some((m) => {
      const from = m.message.from
      if (!from) return false
      return from.email === address
    })

    if (!match) {
      throw new Error(`Expected a mail to be sent from [${address}]`)
    }
  }

  /**
   * Assert a mail with specific subject was sent.
   */
  assertSentWithSubject(subject: string): void {
    const mails = this.transport.getMails()
    const match = mails.some((m) => m.message.subject === subject)

    if (!match) {
      throw new Error(`Expected a mail with subject [${subject}] to be sent`)
    }
  }

  /**
   * Assert a mail body contains text.
   */
  assertSentWithBodyContaining(text: string): void {
    const mails = this.transport.getMails()
    const match = mails.some((m) => {
      const html = m.message.html ?? ''
      const textBody = m.message.text ?? ''
      return html.includes(text) || textBody.includes(text)
    })

    if (!match) {
      throw new Error(`Expected a mail body to contain [${text}]`)
    }
  }

  /**
   * Assert a mail was sent with CC.
   */
  assertSentWithCc(address: string): void {
    const mails = this.transport.getMails()
    const match = mails.some((m) => {
      const cc = m.message.cc ?? []
      return cc.some((addr) => addr.email === address)
    })

    if (!match) {
      throw new Error(`Expected a mail to be sent with CC to [${address}]`)
    }
  }

  /**
   * Assert a mail was sent with BCC.
   */
  assertSentWithBcc(address: string): void {
    const mails = this.transport.getMails()
    const match = mails.some((m) => {
      const bcc = m.message.bcc ?? []
      return bcc.some((addr) => addr.email === address)
    })

    if (!match) {
      throw new Error(`Expected a mail to be sent with BCC to [${address}]`)
    }
  }

  /**
   * Assert a mail was sent with attachment.
   */
  assertSentWithAttachment(filename: string): void {
    const mails = this.transport.getMails()
    const match = mails.some((m) => {
      const attachments = m.message.attachments ?? []
      return attachments.some((a) => a.filename === filename)
    })

    if (!match) {
      throw new Error(`Expected a mail to be sent with attachment [${filename}]`)
    }
  }

  /**
   * Get sent mails.
   */
  sent(): RecordedMail[] {
    return this.transport.getMails()
  }

  /**
   * Get mails sent to a specific address.
   */
  sentTo(address: string): RecordedMail[] {
    return this.transport.getMails().filter((m) => {
      return m.message.to.some((addr) => addr.email === address)
    })
  }

  /**
   * Clear all recorded mails.
   */
  clear(): void {
    this.transport.clear()
  }
}

/**
 * Create a fake mail for testing.
 */
export function fakeMail(): FakeMail {
  return new FakeMail()
}
