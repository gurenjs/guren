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

export { SmtpTransport } from './transports/SmtpTransport'
export { ResendTransport } from './transports/ResendTransport'
export { MemoryTransport } from './transports/MemoryTransport'
export { LogTransport, type LogTransportOptions } from './transports/LogTransport'

export { MailManager, createMailManager } from './MailManager'

export { Mail, mail, setMailManager, getMailManager } from './Mail'
