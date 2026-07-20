import { beforeEach, afterEach, describe, expect, it } from 'bun:test'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { runCommand } from 'citty'
import { createTempWorkspace, writeInstalledPackage, type TempWorkspace } from './helpers'
import { discoverPluginCommands, createPluginCommandProxy } from '../src/plugin-commands'

const PLUGIN_NAME = '@acme/guren-plugin-audit'

async function writeAppPackageJson(dependencies: Record<string, string>): Promise<void> {
  await writeFile('package.json', JSON.stringify({
    name: 'plugin-commands-app',
    dependencies,
  }, null, 2))
}

async function writeCommandPlugin(names: string[], entry = 'dist/commands.mjs'): Promise<void> {
  const commandEntries = names.map((name) => `  '${name}': {
    meta: { name: '${name}', description: 'Write an audit report' },
    args: {
      out: { type: 'string', default: 'report.txt' },
    },
    async run({ args }) {
      const { writeFile } = await import('node:fs/promises')
      await writeFile(args.out, 'audit-report\\n')
    },
  },`).join('\n')

  await writeInstalledPackage(PLUGIN_NAME, {
    version: '1.0.0',
    gurenPlugin: { commands: { entry, names } },
  }, {
    [entry]: `export default {\n${commandEntries}\n}\n`,
  })
}

describe('plugin-commands', () => {
  let workspace: TempWorkspace

  beforeEach(async () => {
    workspace = await createTempWorkspace('guren-cli-plugin-commands-')
  })

  afterEach(async () => {
    await workspace.cleanup()
  })

  describe('discoverPluginCommands', () => {
    it('should discover namespaced commands from installed plugins', async () => {
      await writeAppPackageJson({ [PLUGIN_NAME]: '^1.0.0' })
      await writeCommandPlugin(['audit:report'])

      const discovered = await discoverPluginCommands()

      expect(discovered).toHaveLength(1)
      expect(discovered[0].name).toBe('audit:report')
      expect(discovered[0].packageName).toBe(PLUGIN_NAME)
      expect(discovered[0].entryPath).toEndWith(join('node_modules', PLUGIN_NAME, 'dist/commands.mjs'))
    })

    it('should return nothing outside an app directory', async () => {
      expect(await discoverPluginCommands()).toEqual([])
    })

    it('should skip dependencies without a commands manifest', async () => {
      await writeAppPackageJson({ [PLUGIN_NAME]: '^1.0.0' })
      await writeInstalledPackage(PLUGIN_NAME, {
        gurenPlugin: { compatibility: '>=1.0.0' },
      })

      expect(await discoverPluginCommands()).toEqual([])
    })

    it('should skip un-namespaced command names', async () => {
      await writeAppPackageJson({ [PLUGIN_NAME]: '^1.0.0' })
      await writeCommandPlugin(['report'])

      expect(await discoverPluginCommands()).toEqual([])
    })

    it('should let built-in command names win', async () => {
      await writeAppPackageJson({ [PLUGIN_NAME]: '^1.0.0' })
      await writeCommandPlugin(['db:migrate'])

      const discovered = await discoverPluginCommands(process.cwd(), new Set(['db:migrate']))

      expect(discovered).toEqual([])
    })

    it('should drop names declared by two plugins', async () => {
      await writeAppPackageJson({
        [PLUGIN_NAME]: '^1.0.0',
        '@acme/guren-plugin-other': '^1.0.0',
      })
      await writeCommandPlugin(['audit:report'])
      await writeInstalledPackage('@acme/guren-plugin-other', {
        gurenPlugin: { commands: { entry: 'dist/commands.mjs', names: ['audit:report', 'other:sync'] } },
      }, { 'dist/commands.mjs': 'export default {}\n' })

      const discovered = await discoverPluginCommands()

      expect(discovered.map((command) => command.name)).toEqual(['other:sync'])
    })

    it('should reject entries escaping the package directory', async () => {
      await writeAppPackageJson({ [PLUGIN_NAME]: '^1.0.0' })
      await writeInstalledPackage(PLUGIN_NAME, {
        gurenPlugin: { commands: { entry: '../../evil.mjs', names: ['audit:report'] } },
      })

      expect(await discoverPluginCommands()).toEqual([])
    })
  })

  describe('createPluginCommandProxy', () => {
    it('should run the real command with parsed args on invocation', async () => {
      await writeAppPackageJson({ [PLUGIN_NAME]: '^1.0.0' })
      await writeCommandPlugin(['audit:report'])

      const [discovered] = await discoverPluginCommands()
      const proxy = createPluginCommandProxy(discovered)

      expect(proxy.meta).toEqual({ name: 'audit:report', description: `Provided by ${PLUGIN_NAME}` })

      await runCommand(proxy, { rawArgs: ['--out', 'custom.txt'] })

      expect(await readFile('custom.txt', 'utf8')).toBe('audit-report\n')
    })

    it('should lazily expose the real argument definitions for usage rendering', async () => {
      await writeAppPackageJson({ [PLUGIN_NAME]: '^1.0.0' })
      await writeCommandPlugin(['audit:report'])

      const [discovered] = await discoverPluginCommands()
      const proxy = createPluginCommandProxy(discovered)

      expect(typeof proxy.args).toBe('function')
      const args = await (proxy.args as () => Promise<Record<string, unknown>>)()
      expect(args).toHaveProperty('out')
    })

    it('should fail clearly when the entry does not export the command', async () => {
      await writeAppPackageJson({ [PLUGIN_NAME]: '^1.0.0' })
      await writeInstalledPackage(PLUGIN_NAME, {
        gurenPlugin: { commands: { entry: 'dist/commands.mjs', names: ['audit:missing'] } },
      }, { 'dist/commands.mjs': 'export default {}\n' })

      const [discovered] = await discoverPluginCommands()
      const proxy = createPluginCommandProxy(discovered)

      await expect(runCommand(proxy, { rawArgs: [] })).rejects.toThrow('does not export a command named "audit:missing"')
    })
  })
})
