import type { MailTransport, MailMessage, SendResult, MemoryTransportOptions } from '../types'

/** In-memory mail transport for testing: stores every sent message for inspection. */
export class MemoryTransport implements MailTransport {
  readonly name = 'memory'
  private messages: MailMessage[] = []
  private simulateFailure: boolean
  private failureMessage: string

  constructor(options: MemoryTransportOptions = {}) {
    this.simulateFailure = options.simulateFailure ?? false
    this.failureMessage = options.failureMessage ?? 'Simulated email failure'
  }

  async send(message: MailMessage): Promise<SendResult> {
    if (this.simulateFailure) {
      return {
        success: false,
        error: this.failureMessage,
      }
    }

    const messageId = `memory-${Date.now()}-${Math.random().toString(36).slice(2)}`
    this.messages.push({ ...message })

    return {
      success: true,
      messageId,
      response: 'Message stored in memory',
    }
  }

  getMessages(): MailMessage[] {
    return [...this.messages]
  }

  getLastMessage(): MailMessage | undefined {
    return this.messages[this.messages.length - 1]
  }

  findByRecipient(email: string): MailMessage[] {
    return this.messages.filter((m) =>
      m.to.some((addr) => addr.email.toLowerCase() === email.toLowerCase())
    )
  }

  findBySubject(subject: string): MailMessage[] {
    return this.messages.filter((m) =>
      m.subject.toLowerCase().includes(subject.toLowerCase())
    )
  }

  hasSentTo(email: string): boolean {
    return this.findByRecipient(email).length > 0
  }

  hasSentWithSubject(subject: string): boolean {
    return this.findBySubject(subject).length > 0
  }

  count(): number {
    return this.messages.length
  }

  clear(): void {
    this.messages = []
  }

  setSimulateFailure(simulate: boolean, message?: string): void {
    this.simulateFailure = simulate
    if (message) {
      this.failureMessage = message
    }
  }

  assertSentTo(email: string): void {
    if (!this.hasSentTo(email)) {
      throw new Error(`No email was sent to ${email}`)
    }
  }

  assertSentWithSubject(subject: string): void {
    if (!this.hasSentWithSubject(subject)) {
      throw new Error(`No email was sent with subject containing "${subject}"`)
    }
  }

  assertSentCount(count: number): void {
    if (this.messages.length !== count) {
      throw new Error(`Expected ${count} emails to be sent, but got ${this.messages.length}`)
    }
  }
}
