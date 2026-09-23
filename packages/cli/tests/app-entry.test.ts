import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { createAppListsFile } from '../src/app-entry'
import { parseSourceFile } from '../src/parse-cache'

const CWD = resolve('/app')
const ENTRY = resolve(CWD, 'src/app.ts')
const PROVIDER = resolve(CWD, 'app/Providers/MailProvider.ts')

function lists(entry: string, file = PROVIDER): boolean | null {
  const program = parseSourceFile(entry, ENTRY)?.program
  if (!program) throw new Error('fixture entry did not parse')
  return createAppListsFile(program, CWD, ENTRY, [file])
}

function entryWith(imports: string, options: string): string {
  return `import { createApp } from '@guren/core'\n${imports}\n\nexport default createApp({ ${options} })\n`
}

describe('createAppListsFile', () => {
  const cases: Array<[string, string, boolean | null, string?]> = [
    ['a relative default import', entryWith("import MailProvider from '../app/Providers/MailProvider.js'", 'providers: [MailProvider]'), true],
    ['an @/ default import', entryWith("import MailProvider from '@/app/Providers/MailProvider'", 'providers: [MailProvider]'), true],
    ['a definition in the config array', entryWith("import mail from '../config/mail.js'", 'config: [mail]'), true, resolve(CWD, 'config/mail.ts')],
    ['a directory import of the file at its index', entryWith("import MailProvider from '../app/Providers/MailProvider'", 'providers: [MailProvider]'), true, resolve(CWD, 'app/Providers/MailProvider/index.ts')],
    ['only other app providers', entryWith("import AuthProvider from '../app/Providers/AuthProvider.js'", 'providers: [AuthProvider]'), false],
    ['package providers beside other app providers', entryWith("import { MailServiceProvider } from '@guren/core'\nimport AuthProvider from '../app/Providers/AuthProvider.js'", 'providers: [MailServiceProvider, AuthProvider]'), false],
    ['no providers or config at all', entryWith('', 'routes: () => {}'), false],
    // A barrel may re-export the file under another path.
    ['a named import from a barrel', entryWith("import { MailProvider } from '../app/Providers/index.js'", 'providers: [MailProvider]'), null],
    ['a default import of the enclosing directory', entryWith("import Providers from '../app/Providers'", 'providers: [Providers]'), null],
    ['a spread', entryWith("import AuthProvider from '../app/Providers/AuthProvider.js'", 'providers: [AuthProvider, ...extraProviders]'), null],
    ['an array built elsewhere', entryWith('', 'providers: appProviders'), null],
    ['options hidden behind a spread', entryWith('', '...baseOptions'), null],
  ]

  for (const [name, entry, expected, file] of cases) {
    test(`reads ${name} as ${String(expected)}`, () => {
      expect(lists(entry, file)).toBe(expected)
    })
  }
})
