import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createAppListsFile, findModuleDescriptor, readModuleDescriptor } from '../src/app-entry'
import { ParseCache, parseSourceFile } from '../src/parse-cache'

const CWD = resolve('/app')
const ENTRY = resolve(CWD, 'src/app.ts')
const PROVIDER = 'app/Providers/MailProvider.ts'
const DECLARED = new Set(['@guren/core'])

function lists(imports: string, options: string, file: string): boolean | null {
  const entry = `import { createApp } from '@guren/core'\n${imports}\n\nexport default createApp({ ${options} })\n`
  const program = parseSourceFile(entry, ENTRY)?.program
  if (!program) throw new Error('fixture entry did not parse')
  return createAppListsFile(program, CWD, ENTRY, [resolve(CWD, file)], DECLARED)
}

describe('createAppListsFile', () => {
  it.each([
    ['a relative default import', true, "import MailProvider from '../app/Providers/MailProvider.js'", 'providers: [MailProvider]', PROVIDER],
    ['an @/ default import', true, "import MailProvider from '@/app/Providers/MailProvider'", 'providers: [MailProvider]', PROVIDER],
    ['a definition in the config array', true, "import mail from '../config/mail.js'", 'config: [mail]', 'config/mail.ts'],
    ['a directory import of the file at its index', true, "import MailProvider from '../app/Providers/MailProvider'", 'providers: [MailProvider]', 'app/Providers/MailProvider/index.ts'],
    ['only other app providers', false, "import AuthProvider from '../app/Providers/AuthProvider.js'", 'providers: [AuthProvider]', PROVIDER],
    ['package providers beside other app providers', false, "import { MailServiceProvider } from '@guren/core'\nimport AuthProvider from '../app/Providers/AuthProvider.js'", 'providers: [MailServiceProvider, AuthProvider]', PROVIDER],
    ['a declared package by a subpath', false, "import { MailServiceProvider } from '@guren/core/mail'\nimport AuthProvider from '../app/Providers/AuthProvider.js'", 'providers: [MailServiceProvider, AuthProvider]', PROVIDER],
    ['no providers or config at all', false, '', 'routes: () => {}', PROVIDER],
    ['a named import from a barrel', null, "import { MailProvider } from '../app/Providers/index.js'", 'providers: [MailProvider]', PROVIDER],
    ['a default import of the enclosing directory', null, "import Providers from '../app/Providers'", 'providers: [Providers]', PROVIDER],
    ['a default import of the enclosing index', null, "import Providers from '../app/Providers/index.js'", 'providers: [Providers]', PROVIDER],
    ['a package.json imports specifier', null, "import MailProvider from '#app/Providers/MailProvider'", 'providers: [MailProvider]', PROVIDER],
    ['a path alias other than @/', null, "import MailProvider from '~/app/Providers/MailProvider'", 'providers: [MailProvider]', PROVIDER],
    ['a path alias spelled like a scoped package', null, "import MailProvider from '@app/Providers/MailProvider'", 'providers: [MailProvider]', PROVIDER],
    ['a path alias spelled like a package', null, "import MailProvider from 'app/Providers/MailProvider'", 'providers: [MailProvider]', PROVIDER],
    ['a package the app does not declare', null, "import { MailerProvider } from 'some-mailer'", 'providers: [MailerProvider]', PROVIDER],
    ['a spread', null, "import AuthProvider from '../app/Providers/AuthProvider.js'", 'providers: [AuthProvider, ...extraProviders]', PROVIDER],
    ['an array built elsewhere', null, '', 'providers: appProviders', PROVIDER],
    ['options hidden behind a spread', null, '', '...baseOptions', PROVIDER],
  ] as const)('reads %s as %p', (_name, expected, imports, options, file) => {
    expect(lists(imports, options, file)).toBe(expected)
  })
})

describe('readModuleDescriptor', () => {
  let root: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'guren-cli-module-descriptor-'))
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  async function writeModule(files: Record<string, string>): Promise<string> {
    const dir = join(root, 'modules/billing')
    await mkdir(dir, { recursive: true })
    for (const [name, content] of Object.entries(files)) {
      await mkdir(join(dir, name, '..'), { recursive: true })
      await writeFile(join(dir, name), content)
    }
    return dir
  }

  const DESCRIPTOR = "import { defineModule } from '@guren/core'\n\nexport default defineModule({ name: 'billing' })\n"

  it.each(['index.ts', 'index.tsx', 'index.mts', 'index.jsx', 'index.mjs'])('reads a descriptor kept in %s', async (file) => {
    const dir = await writeModule({ [file]: DESCRIPTOR })

    const descriptor = await readModuleDescriptor(root, new ParseCache(), dir)

    expect(descriptor).toMatchObject({ file: `modules/billing/${file}` })
  })

  it('reads the file package.json main names ahead of the index', async () => {
    const dir = await writeModule({
      'package.json': JSON.stringify({ main: './src/module.ts' }),
      'src/module.ts': DESCRIPTOR,
      'index.ts': 'export {}\n',
    })

    expect(await findModuleDescriptor(root, dir)).toBe('modules/billing/src/module.ts')
  })

  it('is absent for a module with no entry file', async () => {
    const dir = await writeModule({ 'routes.ts': 'export {}\n' })

    expect(await readModuleDescriptor(root, new ParseCache(), dir)).toBe('absent')
  })
})
