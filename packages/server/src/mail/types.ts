/**
 * Email address with optional display name.
 */
export interface MailAddress {
  /**
   * Email address.
   */
  email: string

  /**
   * Display name.
   */
  name?: string
}

/**
 * Email attachment.
 */
export interface MailAttachment {
  /**
   * Filename shown to recipient.
   */
  filename: string

  /**
   * Attachment content (Buffer or string).
   */
  content?: Buffer | string

  /**
   * Path to file to attach.
   */
  path?: string

  /**
   * MIME type.
   */
  contentType?: string

  /**
   * Content-ID for inline attachments.
   */
  cid?: string
}

/**
 * Email message structure.
 */
export interface MailMessage {
  /**
   * Sender address.
   */
  from?: MailAddress

  /**
   * Primary recipients.
   */
  to: MailAddress[]

  /**
   * Carbon copy recipients.
   */
  cc?: MailAddress[]

  /**
   * Blind carbon copy recipients.
   */
  bcc?: MailAddress[]

  /**
   * Reply-to address.
   */
  replyTo?: MailAddress

  /**
   * Email subject.
   */
  subject: string

  /**
   * Plain text body.
   */
  text?: string

  /**
   * HTML body.
   */
  html?: string

  /**
   * Attachments.
   */
  attachments?: MailAttachment[]

  /**
   * Custom headers.
   */
  headers?: Record<string, string>
}

/**
 * Result of sending an email.
 */
export interface SendResult {
  /**
   * Whether the email was sent successfully.
   */
  success: boolean

  /**
   * Message ID from the mail server.
   */
  messageId?: string

  /**
   * Response from the mail server.
   */
  response?: string

  /**
   * Error message if sending failed.
   */
  error?: string
}

/**
 * Mail transport interface.
 * Implement this to create custom email providers.
 */
export interface MailTransport {
  /**
   * Transport name.
   */
  readonly name: string

  /**
   * Send an email message.
   */
  send(message: MailMessage): Promise<SendResult>
}

/**
 * Mail transport factory function.
 */
export type MailTransportFactory = () => MailTransport

/**
 * Mail transport configuration.
 */
export interface MailTransportConfig {
  /**
   * Transport driver name.
   */
  driver: string

  /**
   * Driver-specific options.
   */
  [key: string]: unknown
}

/**
 * Mail configuration.
 */
export interface MailConfig {
  /**
   * Default transport name.
   * @default 'smtp'
   */
  default?: string

  /**
   * Default from address.
   */
  from?: MailAddress

  /**
   * Transport configurations.
   */
  transports?: Record<string, MailTransportConfig>
}

/**
 * SMTP transport options.
 */
export interface SmtpTransportOptions {
  /**
   * SMTP server host.
   */
  host: string

  /**
   * SMTP server port.
   * @default 587
   */
  port?: number

  /**
   * Use TLS.
   * @default false
   */
  secure?: boolean

  /**
   * Authentication credentials.
   */
  auth?: {
    user: string
    pass: string
  }

  /**
   * Connection pool.
   * @default true
   */
  pool?: boolean

  /**
   * Maximum connections.
   * @default 5
   */
  maxConnections?: number
}

/**
 * Resend transport options.
 */
export interface ResendTransportOptions {
  /**
   * Resend API key.
   */
  apiKey: string
}

/**
 * Memory transport options (for testing).
 */
export interface MemoryTransportOptions {
  /**
   * Whether to simulate failures.
   */
  simulateFailure?: boolean

  /**
   * Error message when simulating failures.
   */
  failureMessage?: string
}
