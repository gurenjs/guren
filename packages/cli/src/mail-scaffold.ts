import { relative, resolve } from 'node:path'
import { consola } from 'consola'
import { createAppOptions, hidesKeys, importedArrayFiles } from './app-entry'
import { propertyValue } from './ast-walk'
import { appBindsService, readIfExists } from './discovery'
import { parseSourceFile } from './parse-cache'
import { resolveAppEntry } from './provider-registrar'
import { withoutExtension } from './schema-binding'
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

/**
 * Whether the entry's `createApp({ providers, config })` imports one of `bindings`, read as
 * `guren check` reads those arrays. `null` is no evidence: no readable entry or array literal,
 * or a binding outside the root's `app/Providers/` and `config/`, which a module or an import
 * of the entry registers instead.
 */
export async function appRegistersMail(bindings: readonly string[]): Promise<boolean | null> {
  const cwd = process.cwd()
  if (!bindings.every((file) => /^(?:app\/Providers|config)\//.test(file.replaceAll('\\', '/')))) return null
  const appPath = await resolveAppEntry(cwd)
  const source = appPath === null ? null : await readIfExists(cwd, appPath)
  if (appPath === null || source === null) return null
  const program = parseSourceFile(source, appPath)?.program
  const options = program ? createAppOptions(program) : null
  if (!program || !options) return null

  const listed: string[] = []
  for (const key of ['providers', 'config']) {
    const declared = propertyValue(options, key)
    if (declared === undefined) {
      if (hidesKeys(options)) return null
      continue
    }
    const files = importedArrayFiles(declared, program, cwd, resolve(cwd, appPath))
    if (files === undefined) return null
    listed.push(...files.filter((file) => file !== null))
  }
  return bindings.some((file) => listed.includes(withoutExtension(resolve(cwd, file))))
}

/** Reports the mail setup a scaffold keeps in place of its own; `instead` says what it did. */
export async function reportKeptMail(bindings: readonly string[], instead: string): Promise<void> {
  const files = bindings.join(', ')
  consola.info(`Mail is already set up in ${files}, so ${instead}.`)
  if ((await appRegistersMail(bindings)) === false) {
    consola.warn(`createApp() does not register ${files} in its providers or config array, so nothing binds 'mail' when the app boots. Add it there.`)
  }
}
