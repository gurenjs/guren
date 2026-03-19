// Types
export type {
  MailAddress,
  MailAttachment,
  MailMessage,
  SendResult,
  MailTransport,
  MailTransportFactory,
  MailTransportConfig,
  MailConfig,
  SmtpTransportOptions,
  ResendTransportOptions,
  MemoryTransportOptions,
} from './types'

// Transports
export { SmtpTransport } from './transports/SmtpTransport'
export { ResendTransport } from './transports/ResendTransport'
export { MemoryTransport } from './transports/MemoryTransport'

// Manager
export { MailManager, createMailManager } from './MailManager'

// Fluent builder
export { Mail, mail, setMailManager, getMailManager } from './Mail'
