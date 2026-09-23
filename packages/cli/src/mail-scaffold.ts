import { relative } from 'node:path'
import { appBindsService } from './discovery'
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
# Which mail transport the app sends through: log, memory, or one the mail config declares.
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

/**
 * The project-relative files that already bind `mail`: a `defineMailConfig()` definition
 * or a provider's `singleton('mail', …)`, the two forms `guren add mail` and `make:auth`
 * write. Read from sources, not file names: a custom provider counts, and a second
 * scaffold over any of them collides on its files or shadows its binding.
 */
export async function appMailBindings(): Promise<string[]> {
  const cwd = process.cwd()
  return (await appBindsService('mail', cwd, { definitions: true })).map((file) => relative(cwd, file))
}
