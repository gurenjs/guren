import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { runCheck } from '../src/check'
import { createTempWorkspace } from './helpers'

describe('runCheck — console command registration', () => {
  const COMMAND_SOURCE = `import { Command } from '@guren/core'
export default class SendDigestCommand extends Command {
  static signature = 'send-digest'
  static description = 'Send the digest'
  async handle(): Promise<void> {}
}`

  async function writeRootCommand(dir: string, name = 'SendDigestCommand'): Promise<void> {
    await mkdir(join(dir, 'app/Console/Commands'), { recursive: true })
    await writeFile(join(dir, `app/Console/Commands/${name}.ts`), COMMAND_SOURCE, 'utf8')
  }

  it('passes when src/console.ts registers the command', async () => {
    const workspace = await createTempWorkspace('guren-cli-check-console-pass-')

    try {
      await writeRootCommand(workspace.dir)
      await mkdir(join(workspace.dir, 'src'), { recursive: true })
      await writeFile(
        join(workspace.dir, 'src/console.ts'),
        `import { ConsoleKernel } from '@guren/core'
import SendDigestCommand from '../app/Console/Commands/SendDigestCommand.js'

export const kernel = new ConsoleKernel()
kernel.registerMany([SendDigestCommand])`,
        'utf8',
      )

      const report = await runCheck({ cwd: workspace.dir })

      const result = report.checks.find(c => c.key === 'console-command:SendDigestCommand')
      expect(result).toBeDefined()
      expect(result!.status).toBe('pass')
    } finally {
      await workspace.cleanup()
    }
  })

  it('warns when a generated command is never registered', async () => {
    const workspace = await createTempWorkspace('guren-cli-check-console-unregistered-')

    try {
      await writeRootCommand(workspace.dir)
      await mkdir(join(workspace.dir, 'src'), { recursive: true })
      await writeFile(
        join(workspace.dir, 'src/console.ts'),
        `import { ConsoleKernel } from '@guren/core'

export const kernel = new ConsoleKernel()
kernel.registerMany([])`,
        'utf8',
      )

      const report = await runCheck({ cwd: workspace.dir })

      const result = report.checks.find(c => c.key === 'console-command:SendDigestCommand')
      expect(result).toBeDefined()
      expect(result!.status).toBe('warn')
      expect(result!.message).toContain('outside its imports')
      expect(result!.suggestion).toContain('kernel.registerMany')
    } finally {
      await workspace.cleanup()
    }
  })

  it('does not count a leftover import as registration', async () => {
    const workspace = await createTempWorkspace('guren-cli-check-console-import-only-')

    try {
      await writeRootCommand(workspace.dir)
      await mkdir(join(workspace.dir, 'src'), { recursive: true })
      // The state left behind by deleting the registration but not the
      // import — the command is still dead.
      await writeFile(
        join(workspace.dir, 'src/console.ts'),
        `import { ConsoleKernel } from '@guren/core'
import SendDigestCommand from '../app/Console/Commands/SendDigestCommand.js'

export const kernel = new ConsoleKernel()
kernel.registerMany([])`,
        'utf8',
      )

      const report = await runCheck({ cwd: workspace.dir })

      const result = report.checks.find(c => c.key === 'console-command:SendDigestCommand')
      expect(result!.status).toBe('warn')
    } finally {
      await workspace.cleanup()
    }
  })

  it('reports a missing src/console.ts once, not once per command', async () => {
    const workspace = await createTempWorkspace('guren-cli-check-console-missing-entry-')

    try {
      await writeRootCommand(workspace.dir, 'SendDigestCommand')
      await writeRootCommand(workspace.dir, 'PruneSessionsCommand')

      const report = await runCheck({ cwd: workspace.dir })

      const entryChecks = report.checks.filter(c => c.key.startsWith('console-entry:'))
      expect(entryChecks).toHaveLength(1)
      expect(entryChecks[0]!.status).toBe('warn')
      expect(entryChecks[0]!.message).toContain('SendDigestCommand')
      expect(entryChecks[0]!.message).toContain('PruneSessionsCommand')
      expect(report.checks.some(c => c.key.startsWith('console-command:'))).toBe(false)
    } finally {
      await workspace.cleanup()
    }
  })

  it('warns rather than passing when the console entrypoint cannot be parsed', async () => {
    const workspace = await createTempWorkspace('guren-cli-check-console-unparseable-')

    try {
      await writeRootCommand(workspace.dir)
      await mkdir(join(workspace.dir, 'src'), { recursive: true })
      await writeFile(join(workspace.dir, 'src/console.ts'), 'kernel.registerMany([SendDigestCommand', 'utf8')

      const report = await runCheck({ cwd: workspace.dir })

      const entryCheck = report.checks.find(c => c.key === 'console-entry:src/console.ts')
      expect(entryCheck).toBeDefined()
      expect(entryCheck!.status).toBe('warn')
      expect(entryCheck!.message).toContain('could not be parsed')
      expect(report.checks.some(c => c.key.startsWith('console-command:'))).toBe(false)
    } finally {
      await workspace.cleanup()
    }
  })

  it('ignores a non-command module living next to the commands', async () => {
    const workspace = await createTempWorkspace('guren-cli-check-console-helper-')

    try {
      await writeRootCommand(workspace.dir)
      await mkdir(join(workspace.dir, 'app/Console/Commands'), { recursive: true })
      // A shared-constants module has no command to register, so no check
      // should ever ask for one.
      await writeFile(
        join(workspace.dir, 'app/Console/Commands/shared-config.ts'),
        `export const TABLES = ['users', 'posts'] as const
export type TableName = (typeof TABLES)[number]`,
        'utf8',
      )
      await mkdir(join(workspace.dir, 'src'), { recursive: true })
      await writeFile(
        join(workspace.dir, 'src/console.ts'),
        `import { ConsoleKernel } from '@guren/core'
import SendDigestCommand from '../app/Console/Commands/SendDigestCommand.js'

export const kernel = new ConsoleKernel()
kernel.registerMany([SendDigestCommand])`,
        'utf8',
      )

      const report = await runCheck({ cwd: workspace.dir })

      expect(report.checks.find(c => c.key === 'console-command:SendDigestCommand')!.status).toBe('pass')
      expect(report.checks.some(c => c.key === 'console-command:SharedConfig')).toBe(false)
    } finally {
      await workspace.cleanup()
    }
  })

  it('does not demand a console entrypoint for a directory holding only helpers', async () => {
    const workspace = await createTempWorkspace('guren-cli-check-console-helper-only-')

    try {
      await mkdir(join(workspace.dir, 'app/Console/Commands'), { recursive: true })
      await writeFile(
        join(workspace.dir, 'app/Console/Commands/shared-config.ts'),
        `export const TABLES = ['users'] as const`,
        'utf8',
      )

      const report = await runCheck({ cwd: workspace.dir })

      expect(report.checks.some(c => c.key.startsWith('console-command:'))).toBe(false)
      expect(report.checks.some(c => c.key.startsWith('console-entry:'))).toBe(false)
    } finally {
      await workspace.cleanup()
    }
  })

  it('keeps an unparseable command file in the check', async () => {
    const workspace = await createTempWorkspace('guren-cli-check-console-unparseable-command-')

    try {
      // Cannot be shown to declare no command, so the conservative reading is
      // the old one: ask for a registration.
      await mkdir(join(workspace.dir, 'app/Console/Commands'), { recursive: true })
      await writeFile(
        join(workspace.dir, 'app/Console/Commands/BrokenCommand.ts'),
        'export default class BrokenCommand extends Command {',
        'utf8',
      )
      await mkdir(join(workspace.dir, 'src'), { recursive: true })
      await writeFile(
        join(workspace.dir, 'src/console.ts'),
        `import { ConsoleKernel } from '@guren/core'

export const kernel = new ConsoleKernel()
kernel.registerMany([])`,
        'utf8',
      )

      const report = await runCheck({ cwd: workspace.dir })

      expect(report.checks.find(c => c.key === 'console-command:BrokenCommand')!.status).toBe('warn')
    } finally {
      await workspace.cleanup()
    }
  })

  it('contributes nothing when the project has no console commands', async () => {
    const workspace = await createTempWorkspace('guren-cli-check-console-none-')

    try {
      const report = await runCheck({ cwd: workspace.dir })

      expect(report.checks.some(c => c.key.startsWith('console-command:'))).toBe(false)
      expect(report.checks.some(c => c.key.startsWith('console-entry:'))).toBe(false)
    } finally {
      await workspace.cleanup()
    }
  })

  it("checks a module's command against the module descriptor, not src/console.ts", async () => {
    const workspace = await createTempWorkspace('guren-cli-check-console-module-')

    try {
      await mkdir(join(workspace.dir, 'modules/billing/app/Console/Commands'), { recursive: true })
      await writeFile(
        join(workspace.dir, 'modules/billing/app/Console/Commands/InvoiceCommand.ts'),
        COMMAND_SOURCE.replace(/SendDigestCommand/g, 'InvoiceCommand'),
        'utf8',
      )
      await writeFile(
        join(workspace.dir, 'modules/billing/index.ts'),
        `import { defineModule } from '@guren/core'
import InvoiceCommand from './app/Console/Commands/InvoiceCommand.js'

export const billingModule = defineModule({ name: 'billing', commands: [InvoiceCommand] })`,
        'utf8',
      )
      await mkdir(join(workspace.dir, 'src'), { recursive: true })
      await writeFile(
        join(workspace.dir, 'src/console.ts'),
        `import { ConsoleKernel } from '@guren/core'
import { billingModule } from '../modules/billing/index.js'

export const kernel = new ConsoleKernel()
kernel.registerMany(billingModule.commands)`,
        'utf8',
      )

      const report = await runCheck({ cwd: workspace.dir })

      const commandCheck = report.checks.find(c => c.key === 'console-command:billing/InvoiceCommand')
      expect(commandCheck).toBeDefined()
      expect(commandCheck!.status).toBe('pass')
      expect(commandCheck!.message).toContain('modules/billing/index.ts')

      const hopCheck = report.checks.find(c => c.key === 'console-module-commands:billing')
      expect(hopCheck).toBeDefined()
      expect(hopCheck!.status).toBe('pass')
    } finally {
      await workspace.cleanup()
    }
  })

  it("does not credit one module's registration to another", async () => {
    const workspace = await createTempWorkspace('guren-cli-check-console-two-modules-')

    try {
      for (const name of ['billing', 'analytics']) {
        const cls = `${name[0]!.toUpperCase()}${name.slice(1)}Command`
        await mkdir(join(workspace.dir, `modules/${name}/app/Console/Commands`), { recursive: true })
        await writeFile(
          join(workspace.dir, `modules/${name}/app/Console/Commands/${cls}.ts`),
          COMMAND_SOURCE.replace(/SendDigestCommand/g, cls),
          'utf8',
        )
        await writeFile(
          join(workspace.dir, `modules/${name}/index.ts`),
          `import { defineModule } from '@guren/core'
import ${cls} from './app/Console/Commands/${cls}.js'

export const ${name}Module = defineModule({ name: '${name}', commands: [${cls}] })`,
          'utf8',
        )
      }

      await mkdir(join(workspace.dir, 'src'), { recursive: true })
      // Both imported, only billing registered — analytics' commands are dead.
      await writeFile(
        join(workspace.dir, 'src/console.ts'),
        `import { ConsoleKernel } from '@guren/core'
import { billingModule } from '../modules/billing/index.js'
import { analyticsModule } from '../modules/analytics/index.js'

export const kernel = new ConsoleKernel()
kernel.registerMany(billingModule.commands)`,
        'utf8',
      )

      const report = await runCheck({ cwd: workspace.dir })

      expect(report.checks.find(c => c.key === 'console-module-commands:billing')!.status).toBe('pass')
      expect(report.checks.find(c => c.key === 'console-module-commands:analytics')!.status).toBe('warn')
    } finally {
      await workspace.cleanup()
    }
  })

  it('accepts a module whose commands are registered by name rather than as an array', async () => {
    const workspace = await createTempWorkspace('guren-cli-check-console-by-name-')

    try {
      await mkdir(join(workspace.dir, 'modules/billing/app/Console/Commands'), { recursive: true })
      await writeFile(
        join(workspace.dir, 'modules/billing/app/Console/Commands/InvoiceCommand.ts'),
        COMMAND_SOURCE.replace(/SendDigestCommand/g, 'InvoiceCommand'),
        'utf8',
      )
      await writeFile(
        join(workspace.dir, 'modules/billing/index.ts'),
        `export { default as InvoiceCommand } from './app/Console/Commands/InvoiceCommand.js'`,
        'utf8',
      )
      await mkdir(join(workspace.dir, 'src'), { recursive: true })
      // The shape a project predating the `commands` field uses.
      await writeFile(
        join(workspace.dir, 'src/console.ts'),
        `import { ConsoleKernel } from '@guren/core'
import { InvoiceCommand } from '../modules/billing/index.js'

export const kernel = new ConsoleKernel()
kernel.registerMany([InvoiceCommand])`,
        'utf8',
      )

      const report = await runCheck({ cwd: workspace.dir })

      expect(report.checks.find(c => c.key === 'console-module-commands:billing')!.status).toBe('pass')
    } finally {
      await workspace.cleanup()
    }
  })

  it('does not credit a prefix-sharing module (billing vs billing-reports)', async () => {
    const workspace = await createTempWorkspace('guren-cli-check-console-prefix-')

    try {
      for (const [name, cls, binding] of [
        ['billing', 'InvoiceCommand', 'billingModule'],
        ['billing-reports', 'DigestCommand', 'billingReportsModule'],
      ] as const) {
        await mkdir(join(workspace.dir, `modules/${name}/app/Console/Commands`), { recursive: true })
        await writeFile(
          join(workspace.dir, `modules/${name}/app/Console/Commands/${cls}.ts`),
          COMMAND_SOURCE.replace(/SendDigestCommand/g, cls),
          'utf8',
        )
        await writeFile(
          join(workspace.dir, `modules/${name}/index.ts`),
          `import { defineModule } from '@guren/core'
import ${cls} from './app/Console/Commands/${cls}.js'

export const ${binding} = defineModule({ name: '${name}', commands: [${cls}] })`,
          'utf8',
        )
      }

      await mkdir(join(workspace.dir, 'src'), { recursive: true })
      await writeFile(
        join(workspace.dir, 'src/console.ts'),
        `import { ConsoleKernel } from '@guren/core'
import { billingReportsModule } from '../modules/billing-reports/index.js'

export const kernel = new ConsoleKernel()
kernel.registerMany(billingReportsModule.commands)`,
        'utf8',
      )

      const report = await runCheck({ cwd: workspace.dir })

      expect(report.checks.find(c => c.key === 'console-module-commands:billing-reports')!.status).toBe('pass')
      expect(report.checks.find(c => c.key === 'console-module-commands:billing')!.status).toBe('warn')
    } finally {
      await workspace.cleanup()
    }
  })

  it('does not let one module\'s command cover another module\'s same-named class', async () => {
    const workspace = await createTempWorkspace('guren-cli-check-console-samename-')

    try {
      for (const name of ['billing', 'analytics']) {
        await mkdir(join(workspace.dir, `modules/${name}/app/Console/Commands`), { recursive: true })
        await writeFile(
          join(workspace.dir, `modules/${name}/app/Console/Commands/InvoiceCommand.ts`),
          COMMAND_SOURCE.replace(/SendDigestCommand/g, 'InvoiceCommand'),
          'utf8',
        )
        await writeFile(
          join(workspace.dir, `modules/${name}/index.ts`),
          `export { default as InvoiceCommand } from './app/Console/Commands/InvoiceCommand.js'`,
          'utf8',
        )
      }

      await mkdir(join(workspace.dir, 'src'), { recursive: true })
      // Only analytics' InvoiceCommand is imported and registered.
      await writeFile(
        join(workspace.dir, 'src/console.ts'),
        `import { ConsoleKernel } from '@guren/core'
import { InvoiceCommand } from '../modules/analytics/index.js'

export const kernel = new ConsoleKernel()
kernel.registerMany([InvoiceCommand])`,
        'utf8',
      )

      const report = await runCheck({ cwd: workspace.dir })

      expect(report.checks.find(c => c.key === 'console-module-commands:analytics')!.status).toBe('pass')
      expect(report.checks.find(c => c.key === 'console-module-commands:billing')!.status).toBe('warn')
    } finally {
      await workspace.cleanup()
    }
  })

  it('accepts a command exposed through a barrel re-export in the module index', async () => {
    const workspace = await createTempWorkspace('guren-cli-check-console-barrel-')

    try {
      await mkdir(join(workspace.dir, 'modules/billing/app/Console/Commands'), { recursive: true })
      await writeFile(
        join(workspace.dir, 'modules/billing/app/Console/Commands/InvoiceCommand.ts'),
        COMMAND_SOURCE.replace(/SendDigestCommand/g, 'InvoiceCommand'),
        'utf8',
      )
      // The index never spells the class name out.
      await writeFile(
        join(workspace.dir, 'modules/billing/index.ts'),
        `export * from './commands.js'`,
        'utf8',
      )
      await writeFile(
        join(workspace.dir, 'modules/billing/commands.ts'),
        `export { default as InvoiceCommand } from './app/Console/Commands/InvoiceCommand.js'`,
        'utf8',
      )
      await mkdir(join(workspace.dir, 'src'), { recursive: true })
      await writeFile(
        join(workspace.dir, 'src/console.ts'),
        `import { ConsoleKernel } from '@guren/core'
import { InvoiceCommand } from '../modules/billing/index.js'

export const kernel = new ConsoleKernel()
kernel.registerMany([InvoiceCommand])`,
        'utf8',
      )

      const report = await runCheck({ cwd: workspace.dir })

      expect(report.checks.find(c => c.key === 'console-command:billing/InvoiceCommand')!.status).toBe('pass')
    } finally {
      await workspace.cleanup()
    }
  })

  it("accepts bracket access to the module's commands", async () => {
    const workspace = await createTempWorkspace('guren-cli-check-console-bracket-access-')

    try {
      await mkdir(join(workspace.dir, 'modules/billing/app/Console/Commands'), { recursive: true })
      await writeFile(
        join(workspace.dir, 'modules/billing/app/Console/Commands/InvoiceCommand.ts'),
        COMMAND_SOURCE.replace(/SendDigestCommand/g, 'InvoiceCommand'),
        'utf8',
      )
      await writeFile(
        join(workspace.dir, 'modules/billing/index.ts'),
        `import { defineModule } from '@guren/core'
import InvoiceCommand from './app/Console/Commands/InvoiceCommand.js'

export const billingModule = defineModule({ name: 'billing', commands: [InvoiceCommand] })`,
        'utf8',
      )
      await mkdir(join(workspace.dir, 'src'), { recursive: true })
      await writeFile(
        join(workspace.dir, 'src/console.ts'),
        `import { ConsoleKernel } from '@guren/core'
import { billingModule } from '../modules/billing/index.js'

export const kernel = new ConsoleKernel()
kernel.registerMany(billingModule['commands'])`,
        'utf8',
      )

      const report = await runCheck({ cwd: workspace.dir })

      expect(report.checks.find(c => c.key === 'console-module-commands:billing')!.status).toBe('pass')
    } finally {
      await workspace.cleanup()
    }
  })

  it('falls back to the conventional binding name for a path-alias import', async () => {
    const workspace = await createTempWorkspace('guren-cli-check-console-alias-')

    try {
      await mkdir(join(workspace.dir, 'modules/billing/app/Console/Commands'), { recursive: true })
      await writeFile(
        join(workspace.dir, 'modules/billing/app/Console/Commands/InvoiceCommand.ts'),
        COMMAND_SOURCE.replace(/SendDigestCommand/g, 'InvoiceCommand'),
        'utf8',
      )
      await writeFile(
        join(workspace.dir, 'modules/billing/index.ts'),
        `import { defineModule } from '@guren/core'
import InvoiceCommand from './app/Console/Commands/InvoiceCommand.js'

export const billingModule = defineModule({ name: 'billing', commands: [InvoiceCommand] })`,
        'utf8',
      )
      await mkdir(join(workspace.dir, 'src'), { recursive: true })
      // The specifier carries no modules/billing/, so the import lookup finds
      // nothing and the conventional billingModule name has to stand in.
      await writeFile(
        join(workspace.dir, 'src/console.ts'),
        `import { ConsoleKernel } from '@guren/core'
import { billingModule } from '#billing'

export const kernel = new ConsoleKernel()
kernel.registerMany(billingModule.commands)`,
        'utf8',
      )

      const report = await runCheck({ cwd: workspace.dir })

      expect(report.checks.find(c => c.key === 'console-module-commands:billing')!.status).toBe('pass')
    } finally {
      await workspace.cleanup()
    }
  })

  it("warns when a module's commands never reach a kernel", async () => {
    const workspace = await createTempWorkspace('guren-cli-check-console-module-hop-')

    try {
      await mkdir(join(workspace.dir, 'modules/billing/app/Console/Commands'), { recursive: true })
      await writeFile(
        join(workspace.dir, 'modules/billing/app/Console/Commands/InvoiceCommand.ts'),
        COMMAND_SOURCE.replace(/SendDigestCommand/g, 'InvoiceCommand'),
        'utf8',
      )
      await writeFile(
        join(workspace.dir, 'modules/billing/index.ts'),
        `import { defineModule } from '@guren/core'
import InvoiceCommand from './app/Console/Commands/InvoiceCommand.js'

export const billingModule = defineModule({ name: 'billing', commands: [InvoiceCommand] })`,
        'utf8',
      )
      await mkdir(join(workspace.dir, 'src'), { recursive: true })
      await writeFile(
        join(workspace.dir, 'src/console.ts'),
        `import { ConsoleKernel } from '@guren/core'

export const kernel = new ConsoleKernel()
kernel.registerMany([])`,
        'utf8',
      )

      const report = await runCheck({ cwd: workspace.dir })

      // The module wired it up correctly, so only the second hop warns.
      expect(report.checks.find(c => c.key === 'console-command:billing/InvoiceCommand')!.status).toBe('pass')

      const hopCheck = report.checks.find(c => c.key === 'console-module-commands:billing')
      expect(hopCheck).toBeDefined()
      expect(hopCheck!.status).toBe('warn')
      expect(hopCheck!.suggestion).toContain('kernel.registerMany(billingModule.commands)')
    } finally {
      await workspace.cleanup()
    }
  })
})
