import { describe, expect, test } from 'bun:test'
import { cp, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  applyContainerResolution,
  detectContainerResolution,
  transformSource,
} from '../src/codemod-container-resolution'
import { codemods, findApplicableCodemods, runCodemods } from '../src/codemods'
import { writeWorkspaceFiles } from './helpers'

const REPO_ROOT = join(import.meta.dir, '../../..')

async function scratchApp(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'guren-codemod-'))
  await writeWorkspaceFiles(dir, files)
  return dir
}

/** Applying twice must leave the second run with nothing to do. */
async function applyTwice(dir: string): Promise<{ first: number; second: number; detected: string[] }> {
  const detected = await detectContainerResolution(dir)
  const first = await applyContainerResolution(dir)
  const second = await applyContainerResolution(dir)
  return { first, second, detected }
}

describe('the RFC 0023 codemod', () => {
  test('rewrites a getter inside a service provider to the container it holds', () => {
    const source = [
      "import { ServiceProvider, getGate } from '@guren/core'",
      "import { Post } from '../Models/Post.js'",
      '',
      'export default class AuthorizationProvider extends ServiceProvider {',
      '  boot(): void {',
      '    getGate().policy(Post, Post)',
      '  }',
      '}',
      '',
    ].join('\n')

    const output = transformSource(source, 'app/Providers/AuthorizationProvider.ts')

    expect(output).toContain("this.container.make('gate').policy(Post, Post)")
    expect(output).toContain("import { ServiceProvider } from '@guren/core'")
    expect(output).not.toContain('getGate')
  })

  test('deletes a setter whose key a provider in the same file already binds', () => {
    const source = [
      "import { ServiceProvider, setMailManager } from '@guren/core'",
      '',
      'function boot(manager: never): void {',
      '  setMailManager(manager)',
      '}',
      '',
      'export default class MailProvider extends ServiceProvider {',
      '  register(): void {',
      "    this.container.singleton('mail', () => manager)",
      '  }',
      '}',
      '',
    ].join('\n')

    const output = transformSource(source, 'app/Providers/MailProvider.ts')

    expect(output).not.toContain('setMailManager')
    expect(output).toContain("this.container.singleton('mail'")
  })

  test('binds the value on the container when the provider binds nothing', () => {
    const source = [
      "import { ServiceProvider, setMailManager } from '@guren/core'",
      '',
      'export default class MailProvider extends ServiceProvider {',
      '  boot(): void {',
      '    setMailManager(manager)',
      '  }',
      '}',
      '',
    ].join('\n')

    expect(transformSource(source, 'app/Providers/MailProvider.ts')).toContain(
      "this.container.instance('mail', manager)",
    )
  })

  test('moves an inline setInertiaDocument literal into createApp options', () => {
    const source = [
      "import { createApp, setInertiaDocument } from '@guren/core'",
      '',
      '// Rendered into every server-rendered document.',
      'setInertiaDocument({',
      "  head: '<link rel=\"icon\" href=\"/favicon.svg\" />',",
      '})',
      '',
      'const app = createApp({',
      '  routes: registerWebRoutes,',
      '})',
      '',
    ].join('\n')

    const output = transformSource(source, 'src/app.ts')

    expect(output).toContain('  inertia: {\n    document: {')
    expect(output).toContain('// Rendered into every server-rendered document.')
    expect(output).not.toContain('setInertiaDocument')
    expect(output).toContain("import { createApp } from '@guren/core'")
  })

  test('leaves setInertiaDocument alone when createApp is in another file', () => {
    const source = [
      "import { setInertiaDocument } from '@guren/core'",
      '',
      "setInertiaDocument({ head: '' })",
      '',
    ].join('\n')

    expect(transformSource(source, 'config/inertia.ts')).toBeNull()
  })

  test('gives the attachments storage factory the container it is bound with', () => {
    const source = [
      "import { configureAttachments, getContainer } from '@guren/core'",
      '',
      'export const { Attachment } = configureAttachments({',
      '  table: attachments,',
      "  storage: () => getContainer().make('storage'),",
      "  disk: 'media',",
      '})',
      '',
    ].join('\n')

    const output = transformSource(source, 'config/attachments.ts')

    expect(output).toContain("storage: (container) => container.make('storage')")
    expect(output).toContain("import { configureAttachments } from '@guren/core'")
  })

  test('rewrites getContainer().make() inside a Job to this.make()', () => {
    const source = [
      "import { Job, getContainer, type StorageManager } from '@guren/core'",
      '',
      'export class ReportJob extends Job<{ id: number }> {',
      '  async handle(): Promise<void> {',
      "    const storage = getContainer().make<StorageManager>('storage')",
      '  }',
      '}',
      '',
    ].join('\n')

    const output = transformSource(source, 'app/Jobs/ReportJob.ts')

    expect(output).toContain("this.make<StorageManager>('storage')")
    expect(output).toContain("import { Job, type StorageManager } from '@guren/core'")
  })

  test('reports rather than rewrites a test injecting a fake', () => {
    const source = [
      "import { setGate, setQueueDriver } from '@guren/core'",
      '',
      'setQueueDriver(fake)',
      'setGate(gate)',
      '',
    ].join('\n')

    expect(transformSource(source, 'app/support/inject.ts')).toBeNull()
  })

  test('is selected for the versions a scaffolded app upgrades between', () => {
    const codemod = codemods.find((entry) => entry.id === 'container-only-service-resolution')
    expect(codemod).toBeDefined()
    // `checkVersionCompatibility()` anchors on the first @guren/* pin naming an
    // exact release, which every template orders as @guren/cli.
    expect(findApplicableCodemods('2.21.0', '2.22.0').map((entry) => entry.id)).toContain(
      'container-only-service-resolution',
    )
  })

  test('runs through the codemod registry and is idempotent', async () => {
    const dir = await scratchApp({
      'app/Providers/AuthorizationProvider.ts': [
        "import { ServiceProvider, getGate } from '@guren/core'",
        '',
        'export default class AuthorizationProvider extends ServiceProvider {',
        '  boot(): void {',
        '    getGate().policy(Post, PostPolicy)',
        '  }',
        '}',
        '',
      ].join('\n'),
    })

    try {
      const applied = await runCodemods(dir, '2.21.0', '2.22.0')
      expect(applied).toEqual([
        expect.objectContaining({ id: 'container-only-service-resolution', status: 'applied', filesAffected: 1 }),
      ])

      const again = await runCodemods(dir, '2.21.0', '2.22.0')
      expect(again).toEqual([
        expect.objectContaining({ id: 'container-only-service-resolution', status: 'skipped', filesAffected: 0 }),
      ])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('migrates the blog example and changes nothing on a second run', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'guren-codemod-blog-'))
    try {
      for (const directory of ['app', 'config', 'src', 'routes', 'db']) {
        await cp(join(REPO_ROOT, 'examples/blog', directory), join(dir, directory), { recursive: true })
      }

      const { first, second, detected } = await applyTwice(dir)

      expect(detected).toContain('app/Providers/EventServiceProvider.ts')
      expect(first).toBe(detected.length)
      expect(second).toBe(0)

      const provider = await readFile(join(dir, 'app/Providers/EventServiceProvider.ts'), 'utf8')
      expect(provider).not.toContain('setMailManager')
      expect(provider).toContain("this.container.singleton('mail'")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
