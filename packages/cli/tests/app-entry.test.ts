import { describe, expect, it } from 'bun:test'
import { resolve } from 'node:path'
import { createAppListsFile } from '../src/app-entry'
import { parseSourceFile } from '../src/parse-cache'

const CWD = resolve('/app')
const ENTRY = resolve(CWD, 'src/app.ts')
const PROVIDER = 'app/Providers/MailProvider.ts'

function lists(imports: string, options: string, file: string): boolean | null {
  const entry = `import { createApp } from '@guren/core'\n${imports}\n\nexport default createApp({ ${options} })\n`
  const program = parseSourceFile(entry, ENTRY)?.program
  if (!program) throw new Error('fixture entry did not parse')
  return createAppListsFile(program, CWD, ENTRY, [resolve(CWD, file)])
}

describe('createAppListsFile', () => {
  it.each([
    ['a relative default import', true, "import MailProvider from '../app/Providers/MailProvider.js'", 'providers: [MailProvider]', PROVIDER],
    ['an @/ default import', true, "import MailProvider from '@/app/Providers/MailProvider'", 'providers: [MailProvider]', PROVIDER],
    ['a definition in the config array', true, "import mail from '../config/mail.js'", 'config: [mail]', 'config/mail.ts'],
    ['a directory import of the file at its index', true, "import MailProvider from '../app/Providers/MailProvider'", 'providers: [MailProvider]', 'app/Providers/MailProvider/index.ts'],
    ['only other app providers', false, "import AuthProvider from '../app/Providers/AuthProvider.js'", 'providers: [AuthProvider]', PROVIDER],
    ['package providers beside other app providers', false, "import { MailServiceProvider } from '@guren/core'\nimport AuthProvider from '../app/Providers/AuthProvider.js'", 'providers: [MailServiceProvider, AuthProvider]', PROVIDER],
    ['no providers or config at all', false, '', 'routes: () => {}', PROVIDER],
    ['a named import from a barrel', null, "import { MailProvider } from '../app/Providers/index.js'", 'providers: [MailProvider]', PROVIDER],
    ['a default import of the enclosing directory', null, "import Providers from '../app/Providers'", 'providers: [Providers]', PROVIDER],
    ['a default import of the enclosing index', null, "import Providers from '../app/Providers/index.js'", 'providers: [Providers]', PROVIDER],
    ['a package.json imports specifier', null, "import MailProvider from '#app/Providers/MailProvider'", 'providers: [MailProvider]', PROVIDER],
    ['a path alias other than @/', null, "import MailProvider from '~/app/Providers/MailProvider'", 'providers: [MailProvider]', PROVIDER],
    ['a spread', null, "import AuthProvider from '../app/Providers/AuthProvider.js'", 'providers: [AuthProvider, ...extraProviders]', PROVIDER],
    ['an array built elsewhere', null, '', 'providers: appProviders', PROVIDER],
    ['options hidden behind a spread', null, '', '...baseOptions', PROVIDER],
  ] as const)('reads %s as %p', (_name, expected, imports, options, file) => {
    expect(lists(imports, options, file)).toBe(expected)
  })
})
