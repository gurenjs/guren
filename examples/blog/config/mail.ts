import { defineMailConfig } from '@guren/core'

export default defineMailConfig((env) => {
  const transports = {
    // The default, not `memory`: development needs the verification and
    // password-reset links printed, and `memory` discards them silently.
    log: { driver: 'log' },
    memory: { driver: 'memory' },
    resend: { driver: 'resend', apiKey: env.RESEND_API_KEY ?? '' },
  } as const

  // Checked at boot: the manager accepts any name and throws on the first send.
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
