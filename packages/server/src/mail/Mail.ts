import type {
  MailAddress,
  MailAttachment,
  MailMessage,
  SendResult,
} from './types'
import type { MailManager } from './MailManager'
import { Job, getQueueDriver, registerJob } from '../queue'
import { parseMailAddress as parseAddress } from './address'

/**
 * The message of a thrown value, whether or not it is an `Error`: a failed
 * dynamic import throws Bun's `ResolveMessage`, which is not one.
 */
function errorMessage(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'message' in error) {
    return String((error as { message: unknown }).message)
  }
  return String(error)
}

/** Fluent mail builder for composing and sending emails. */
export class Mail {
  private message: Partial<MailMessage> = {
    to: [],
    cc: [],
    bcc: [],
    attachments: [],
  }
  private transportName?: string

  constructor(private readonly manager: MailManager) {
    const defaultFrom = manager.getDefaultFrom()
    if (defaultFrom) {
      this.message.from = defaultFrom
    }
  }

  from(address: string | MailAddress): this {
    this.message.from = parseAddress(address)
    return this
  }

  to(address: string | MailAddress): this {
    this.message.to!.push(parseAddress(address))
    return this
  }

  toMany(addresses: (string | MailAddress)[]): this {
    for (const addr of addresses) {
      this.to(addr)
    }
    return this
  }

  cc(address: string | MailAddress): this {
    this.message.cc!.push(parseAddress(address))
    return this
  }

  bcc(address: string | MailAddress): this {
    this.message.bcc!.push(parseAddress(address))
    return this
  }

  replyTo(address: string | MailAddress): this {
    this.message.replyTo = parseAddress(address)
    return this
  }

  subject(subject: string): this {
    this.message.subject = subject
    return this
  }

  text(content: string): this {
    this.message.text = content
    return this
  }

  html(content: string): this {
    this.message.html = content
    return this
  }

  /** Render a React component as the HTML body; requires @react-email/render. */
  async template<P extends Record<string, unknown>>(
    component: (props: P) => unknown,
    props: P
  ): Promise<this> {
    const name = component.name || '(anonymous)'
    let reactEmail: { render: (element: unknown) => Promise<string> }

    try {
      const reactEmailModule = '@react-email/render'

      // Dynamic import to avoid requiring react-email in production
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      reactEmail = await import(/* @vite-ignore */ reactEmailModule as any) as {
        render: (element: unknown) => Promise<string>
      }
    } catch (error) {
      throw new Error(
        `Failed to load @react-email/render for template "${name}": ${errorMessage(error)}. ` +
          'Make sure @react-email/render is installed.',
        { cause: error }
      )
    }

    try {
      this.message.html = await reactEmail.render(component(props))
    } catch (error) {
      // No install hint here: the package loaded, so the failure is the
      // template's own.
      throw new Error(`Failed to render email template "${name}": ${errorMessage(error)}`, {
        cause: error,
      })
    }

    return this
  }

  attach(attachment: MailAttachment): this {
    this.message.attachments!.push(attachment)
    return this
  }

  /** Add a custom header. Rejects CR/LF to prevent SMTP header injection. */
  header(key: string, value: string): this {
    if (/[\r\n]/.test(key) || /[\r\n]/.test(value)) {
      throw new Error('Mail: header names and values cannot contain newline characters.')
    }
    if (!this.message.headers) {
      this.message.headers = {}
    }
    this.message.headers[key] = value
    return this
  }

  /** Specify which transport to use. */
  via(transport: string): this {
    this.transportName = transport
    return this
  }

  /**
   * Mailable subclasses define their content here; it runs automatically before
   * sending, so no manual build() call is needed.
   */
  protected build?(): this

  private hasRunBuild = false

  private runBuildOnce(): void {
    if (this.hasRunBuild) {
      return
    }
    this.hasRunBuild = true
    this.build?.()
  }

  buildMessage(): MailMessage {
    this.runBuildOnce()

    if (!this.message.to || this.message.to.length === 0) {
      throw new Error('Email must have at least one recipient')
    }
    if (!this.message.subject) {
      throw new Error('Email must have a subject')
    }
    if (!this.message.text && !this.message.html) {
      throw new Error('Email must have a text or html body')
    }

    return this.message as MailMessage
  }

  /** Send the email immediately. */
  async send(): Promise<SendResult> {
    const message = this.buildMessage()
    const transport = this.manager.transport(this.transportName)
    return transport.send(message)
  }

  /** Queue the email for async sending. */
  async queue(queueName: string = 'default'): Promise<string> {
    const driver = getQueueDriver()
    if (!driver) {
      throw new Error('Queue driver not configured. Use send() instead or configure a queue driver.')
    }

    const message = this.buildMessage()

    registerJob(SendMailJob)

    return SendMailJob.dispatch(
      {
        message,
        transport: this.transportName ?? this.manager.getDefaultTransportName(),
      },
      { queue: queueName }
    )
  }
}

interface SendMailJobPayload {
  message: MailMessage
  transport: string
}

let globalMailManager: MailManager | null = null

/** Set the global mail manager used by queue jobs. */
export function setMailManager(manager: MailManager): void {
  globalMailManager = manager
}

export function getMailManager(): MailManager | null {
  return globalMailManager
}

class SendMailJob extends Job<SendMailJobPayload> {
  static jobName = 'SendMailJob'
  static queue = 'default'
  static maxAttempts = 3
  static backoff: 'exponential' = 'exponential'

  async handle(payload: SendMailJobPayload): Promise<void> {
    const manager = globalMailManager
    if (!manager) {
      throw new Error('Mail manager not configured for queue jobs. Call setMailManager() first.')
    }

    const transport = manager.transport(payload.transport)
    const result = await transport.send(payload.message)

    if (!result.success) {
      throw new Error(result.error ?? 'Failed to send email')
    }
  }
}

/** Create a new mail builder. */
export function mail(manager: MailManager): Mail {
  return new Mail(manager)
}
