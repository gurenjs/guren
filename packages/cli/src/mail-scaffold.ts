import { resolve } from 'node:path'
import { consola } from 'consola'
import { createAppListsFile } from './app-entry'
import { appBindsService, toPosixRelative } from './discovery'
import { ParseCache } from './parse-cache'
import { resolveAppEntry } from './provider-registrar'
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
 * The project-relative files binding `mail` (a `defineMailConfig()` definition or a provider's
 * `singleton('mail', …)`), which `guren add mail` and `make:auth` keep instead of writing their own.
 */
export async function appMailBindings(): Promise<string[]> {
  const cwd = process.cwd()
  return (await appBindsService('mail', cwd, { definitions: true })).map((file) => toPosixRelative(cwd, file))
}

/** A module's binding, or one outside the root's providers and config, is registered elsewhere. */
async function provablyUnregistered(bindings: readonly string[]): Promise<boolean> {
  if (!bindings.every((file) => /^(?:app\/Providers|config)\//.test(file))) return false
  const cwd = process.cwd()
  const entry = await resolveAppEntry(cwd)
  if (entry === null) return false
  const entryFile = resolve(cwd, entry)
  const parsed = await new ParseCache().get(entryFile)
  if (parsed === null) return false
  return createAppListsFile(parsed.ast.program, cwd, entryFile, bindings.map((file) => resolve(cwd, file))) === false
}

/** Reports the mail setup a scaffold keeps in place of its own; `instead` says what it did. */
export async function reportKeptMail(bindings: readonly string[], instead: string): Promise<void> {
  const files = bindings.join(', ')
  consola.info(`Mail is already set up in ${files}, so ${instead}.`)
  if (await provablyUnregistered(bindings)) {
    consola.warn(`createApp() does not register ${files} in its providers or config array, so nothing binds 'mail' when the app boots. Add it there.`)
  }
}
