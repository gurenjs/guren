/** Email address with optional display name. */
export interface MailAddress {
  email: string

  name?: string
}

/** Email attachment. */
export interface MailAttachment {
  /** Filename shown to the recipient. */
  filename: string

  content?: Buffer | string

  /** Path to file to attach. */
  path?: string

  contentType?: string

  /** Content-ID for inline attachments. */
  cid?: string
}

/** Email message structure. */
export interface MailMessage {
  from?: MailAddress

  to: MailAddress[]

  cc?: MailAddress[]

  bcc?: MailAddress[]

  replyTo?: MailAddress

  subject: string

  /** Plain text body. */
  text?: string

  /** HTML body. */
  html?: string

  attachments?: MailAttachment[]

  headers?: Record<string, string>
}

/** Result of sending an email. */
export interface SendResult {
  success: boolean

  /** Message ID from the mail server. */
  messageId?: string

  /** Response from the mail server. */
  response?: string

  /** Error message if sending failed. */
  error?: string
}

/** Mail transport interface. Implement it to add a custom email provider. */
export interface MailTransport {
  readonly name: string

  send(message: MailMessage): Promise<SendResult>
}

/** Mail transport factory function. */
export type MailTransportFactory = () => MailTransport

/** Mail transport configuration. */
export interface MailTransportConfig {
  driver: string

  /** Driver-specific options. */
  [key: string]: unknown
}

/** Mail configuration. */
export interface MailConfig {
  /** @default 'smtp' */
  default?: string

  /** Default from address. */
  from?: MailAddress

  transports?: Record<string, MailTransportConfig>
}

/** SMTP transport options. */
export interface SmtpTransportOptions {
  host: string

  /** @default 587 */
  port?: number

  /** Use TLS. @default false */
  secure?: boolean

  /** Authentication credentials. */
  auth?: {
    user: string
    pass: string
  }

  /** Use a connection pool. @default true */
  pool?: boolean

  /** @default 5 */
  maxConnections?: number
}

/** Resend transport options. */
export interface ResendTransportOptions {
  apiKey: string
}

/** Memory transport options (for testing). */
export interface MemoryTransportOptions {
  simulateFailure?: boolean

  /** Error message when simulating failures. */
  failureMessage?: string
}
