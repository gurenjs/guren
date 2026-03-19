import type { MailTransport, MailMessage, SendResult, MemoryTransportOptions } from '../types'

/**
 * In-memory mail transport for testing.
 *
 * Stores all sent messages in memory for inspection.
 *
 * @example
 * ```ts
 * const transport = new MemoryTransport()
 *
 * await transport.send({
 *   from: { email: 'sender@example.com' },
 *   to: [{ email: 'recipient@example.com' }],
 *   subject: 'Hello',
 *   text: 'Hello World!',
 * })
 *
 * // Inspect sent messages
 * const messages = transport.getMessages()
 * console.log(messages[0].subject) // 'Hello'
 * ```
 */
export class MemoryTransport implements MailTransport {
  readonly name = 'memory'
  private messages: MailMessage[] = []
  private simulateFailure: boolean
  private failureMessage: string

  constructor(options: MemoryTransportOptions = {}) {
    this.simulateFailure = options.simulateFailure ?? false
    this.failureMessage = options.failureMessage ?? 'Simulated email failure'
  }

  /**
   * Send an email (stores in memory).
   */
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

  /**
   * Get all sent messages.
   */
  getMessages(): MailMessage[] {
    return [...this.messages]
  }

  /**
   * Get the last sent message.
   */
  getLastMessage(): MailMessage | undefined {
    return this.messages[this.messages.length - 1]
  }

  /**
   * Find messages by recipient email.
   */
  findByRecipient(email: string): MailMessage[] {
    return this.messages.filter((m) =>
      m.to.some((addr) => addr.email.toLowerCase() === email.toLowerCase())
    )
  }

  /**
   * Find messages by subject.
   */
  findBySubject(subject: string): MailMessage[] {
    return this.messages.filter((m) =>
      m.subject.toLowerCase().includes(subject.toLowerCase())
    )
  }

  /**
   * Check if any message was sent to a recipient.
   */
  hasSentTo(email: string): boolean {
    return this.findByRecipient(email).length > 0
  }

  /**
   * Check if any message was sent with a subject.
   */
  hasSentWithSubject(subject: string): boolean {
    return this.findBySubject(subject).length > 0
  }

  /**
   * Get the count of sent messages.
   */
  count(): number {
    return this.messages.length
  }

  /**
   * Clear all stored messages.
   */
  clear(): void {
    this.messages = []
  }

  /**
   * Set whether to simulate failures.
   */
  setSimulateFailure(simulate: boolean, message?: string): void {
    this.simulateFailure = simulate
    if (message) {
      this.failureMessage = message
    }
  }

  /**
   * Assert that a message was sent to a recipient.
   * Throws if no message was found.
   */
  assertSentTo(email: string): void {
    if (!this.hasSentTo(email)) {
      throw new Error(`No email was sent to ${email}`)
    }
  }

  /**
   * Assert that a message was sent with a subject.
   * Throws if no message was found.
   */
  assertSentWithSubject(subject: string): void {
    if (!this.hasSentWithSubject(subject)) {
      throw new Error(`No email was sent with subject containing "${subject}"`)
    }
  }

  /**
   * Assert that exactly n messages were sent.
   * Throws if count doesn't match.
   */
  assertSentCount(count: number): void {
    if (this.messages.length !== count) {
      throw new Error(`Expected ${count} emails to be sent, but got ${this.messages.length}`)
    }
  }
}
