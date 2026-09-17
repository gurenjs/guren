import { defineMailConfig } from '@guren/core'

// Set MAIL_MAILER in .env to pick a transport: `log` prints outgoing mail to
// the server output (nothing to configure in development), `memory` keeps it
// in process for tests, and `smtp` sends it through the SMTP_* keys.
export default defineMailConfig((env) => {
  const transports = {
    log: { driver: 'log' },
    memory: { driver: 'memory' },
    smtp: {
      driver: 'smtp',
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      // An SMTP server without authentication (a local catcher) needs no user.
      auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS ?? '' } : undefined,
    },
  }

  // Checked here rather than at the first send, which can be a queued job
  // or a rarely-hit route in production.
  if (!Object.hasOwn(transports, env.MAIL_MAILER)) {
    throw new Error(
      `MAIL_MAILER="${env.MAIL_MAILER}" is not a declared transport. Declare it in config/mail.ts or use one of: ${Object.keys(transports).join(', ')}.`,
    )
  }

  return {
    default: env.MAIL_MAILER,
    from: { email: env.MAIL_FROM_ADDRESS, name: env.MAIL_FROM_NAME },
    transports,
  }
})
