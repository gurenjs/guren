import type { ServiceScaffold } from './service-scaffold'

/** The mail service `guren add mail` installs and `make:auth` shares for its reset mail (RFC 0027 §2). */
export const MAIL_SCAFFOLD: ServiceScaffold = {
  key: 'mail',
  coreProvider: 'MailServiceProvider',
  provider: 'MailProvider',
  env: [
    {
      key: 'MAIL_MAILER',
      entry: `
# Which mail transport the app sends through. Declare it in the mail config before naming it here.
MAIL_MAILER=log
`,
    },
    { key: 'MAIL_FROM_ADDRESS', entry: 'MAIL_FROM_ADDRESS=noreply@example.com\n' },
    { key: 'MAIL_FROM_NAME', entry: 'MAIL_FROM_NAME=Guren\n' },
  ],
  definitionEnv: [
    { key: 'SMTP_HOST', entry: 'SMTP_HOST=localhost\n' },
    { key: 'SMTP_PORT', entry: 'SMTP_PORT=587\n', declare: { type: 'port' } },
    { key: 'SMTP_USER', entry: 'SMTP_USER=\n' },
    { key: 'SMTP_PASS', entry: 'SMTP_PASS=\n', declare: { secret: true } },
  ],
}
