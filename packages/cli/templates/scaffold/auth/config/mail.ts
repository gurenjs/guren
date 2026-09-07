import type { MailConfig } from '@guren/core'

// Defaults to the `log` driver, which prints outgoing emails to the
// console instead of sending them — nothing to configure for local
// development. Set MAIL_DRIVER=smtp (and the SMTP_* variables below)
// once you're ready to send real email.
// `||`, not `??`: a blanked `FOO=` is '', which none of these accept.
export const mailConfig: MailConfig = {
  default: process.env.MAIL_DRIVER || 'log',
  from: {
    email: process.env.MAIL_FROM_ADDRESS || 'noreply@example.com',
    // `??` here: an empty display name is a choice, not a missing value.
    name: process.env.MAIL_FROM_NAME ?? 'Guren',
  },
  transports: {
    log: { driver: 'log' },
    smtp: {
      driver: 'smtp',
      host: process.env.SMTP_HOST || 'localhost',
      // `Number('')` is 0, so a blank port would silently win over 587.
      port: Number(process.env.SMTP_PORT || 587),
      auth: {
        user: process.env.SMTP_USER ?? '',
        pass: process.env.SMTP_PASS ?? '',
      },
    },
  },
}
