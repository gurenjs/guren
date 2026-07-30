import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { makeCommand, registerScaffoldedCommand } from '../src/make-command'
import { createTempWorkspace } from './helpers'

const CONSOLE_TEMPLATE = `import { ConsoleKernel } from '@guren/core'
import app from './app.js'

export const kernel = new ConsoleKernel({ container: app.container })

// Register the classes \`bunx guren make:command\` writes to app/Console/Commands:
//   import SendDigestCommand from '../app/Console/Commands/SendDigestCommand.js'
kernel.registerMany([])
`

const MODULE_INDEX = `import { defineModule } from '@guren/core'
import { registerBillingRoutes } from './routes'

export const billingModule = defineModule({
  name: 'billing',
  prefix: '/billing',
  routes: registerBillingRoutes,
})
`

async function writeConsoleEntry(dir: string, contents = CONSOLE_TEMPLATE): Promise<void> {
  await mkdir(join(dir, 'src'), { recursive: true })
  await writeFile(join(dir, 'src/console.ts'), contents, 'utf8')
}

async function writeModuleIndex(dir: string, contents = MODULE_INDEX): Promise<void> {
  await mkdir(join(dir, 'modules/billing'), { recursive: true })
  await writeFile(join(dir, 'modules/billing/index.ts'), contents, 'utf8')
}

async function scaffoldAndRegister(name: string, options: { root?: string } = {}): Promise<string> {
  const file = await makeCommand(name, options)
  await registerScaffoldedCommand(name, file, options)
  return file
}

describe('registerScaffoldedCommand', () => {
  describe('project-level commands', () => {
    it('imports and registers the command in src/console.ts', async () => {
      const workspace = await createTempWorkspace('guren-cli-cmd-register-root-')
      try {
        await writeConsoleEntry(workspace.dir)

        await scaffoldAndRegister('SendDigest')

        const consoleSource = await readFile(join(workspace.dir, 'src/console.ts'), 'utf8')
        expect(consoleSource).toContain("import SendDigestCommand from '../app/Console/Commands/SendDigestCommand.js'")
        expect(consoleSource).toContain('kernel.registerMany([SendDigestCommand])')
      } finally {
        await workspace.cleanup()
      }
    })

    it('appends to an array that already holds commands', async () => {
      const workspace = await createTempWorkspace('guren-cli-cmd-register-append-')
      try {
        await writeConsoleEntry(workspace.dir)

        await scaffoldAndRegister('SendDigest')
        await scaffoldAndRegister('PruneSessions')

        const consoleSource = await readFile(join(workspace.dir, 'src/console.ts'), 'utf8')
        expect(consoleSource).toContain('kernel.registerMany([SendDigestCommand, PruneSessionsCommand])')
      } finally {
        await workspace.cleanup()
      }
    })

    it('is idempotent — re-registering the same command changes nothing', async () => {
      const workspace = await createTempWorkspace('guren-cli-cmd-register-idempotent-')
      try {
        await writeConsoleEntry(workspace.dir)

        const file = await scaffoldAndRegister('SendDigest')
        const afterFirst = await readFile(join(workspace.dir, 'src/console.ts'), 'utf8')

        await registerScaffoldedCommand('SendDigest', file, {})

        const afterSecond = await readFile(join(workspace.dir, 'src/console.ts'), 'utf8')
        expect(afterSecond).toBe(afterFirst)
      } finally {
        await workspace.cleanup()
      }
    })

    it('patches a kernel bound to a name other than `kernel`', async () => {
      const workspace = await createTempWorkspace('guren-cli-cmd-register-alias-')
      try {
        await writeConsoleEntry(
          workspace.dir,
          `import { ConsoleKernel } from '@guren/core'

export const consoleKernel = new ConsoleKernel()

consoleKernel.registerMany([])
`,
        )

        await scaffoldAndRegister('SendDigest')

        const consoleSource = await readFile(join(workspace.dir, 'src/console.ts'), 'utf8')
        expect(consoleSource).toContain('consoleKernel.registerMany([SendDigestCommand])')
      } finally {
        await workspace.cleanup()
      }
    })

    it('edits the array-literal registration, not a module `commands` registration', async () => {
      const workspace = await createTempWorkspace('guren-cli-cmd-register-mixed-')
      try {
        await writeConsoleEntry(
          workspace.dir,
          `import { ConsoleKernel } from '@guren/core'
import { billingModule } from '../modules/billing/index.js'

export const kernel = new ConsoleKernel()

kernel.registerMany(billingModule.commands)
kernel.registerMany([])
`,
        )

        await scaffoldAndRegister('SendDigest')

        const consoleSource = await readFile(join(workspace.dir, 'src/console.ts'), 'utf8')
        expect(consoleSource).toContain('kernel.registerMany(billingModule.commands)')
        expect(consoleSource).toContain('kernel.registerMany([SendDigestCommand])')
      } finally {
        await workspace.cleanup()
      }
    })

    it('leaves the project alone when there is no src/console.ts', async () => {
      const workspace = await createTempWorkspace('guren-cli-cmd-register-noentry-')
      try {
        const file = await scaffoldAndRegister('SendDigest')

        expect(file).toContain('app/Console/Commands/SendDigestCommand.ts')
        const created = await readFile(join(workspace.dir, 'src/console.ts'), 'utf8').catch(() => null)
        expect(created).toBeNull()
      } finally {
        await workspace.cleanup()
      }
    })
  })

  describe('module commands', () => {
    it('adds a commands option to the module descriptor', async () => {
      const workspace = await createTempWorkspace('guren-cli-cmd-register-module-')
      try {
        await writeModuleIndex(workspace.dir)

        await scaffoldAndRegister('Invoice', { root: 'billing' })

        const index = await readFile(join(workspace.dir, 'modules/billing/index.ts'), 'utf8')
        expect(index).toContain("import InvoiceCommand from './app/Console/Commands/InvoiceCommand.js'")
        expect(index).toContain('commands: [InvoiceCommand]')
      } finally {
        await workspace.cleanup()
      }
    })

    it('appends to a commands array the module already declares', async () => {
      const workspace = await createTempWorkspace('guren-cli-cmd-register-module-append-')
      try {
        await writeModuleIndex(workspace.dir)

        await scaffoldAndRegister('Invoice', { root: 'billing' })
        await scaffoldAndRegister('Dunning', { root: 'billing' })

        const index = await readFile(join(workspace.dir, 'modules/billing/index.ts'), 'utf8')
        expect(index).toContain('commands: [InvoiceCommand, DunningCommand]')
      } finally {
        await workspace.cleanup()
      }
    })

    it('normalizes --module Billing to the same modules/billing descriptor', async () => {
      const workspace = await createTempWorkspace('guren-cli-cmd-register-module-case-')
      try {
        await writeModuleIndex(workspace.dir)

        await scaffoldAndRegister('Invoice', { root: 'Billing' })

        const index = await readFile(join(workspace.dir, 'modules/billing/index.ts'), 'utf8')
        expect(index).toContain('commands: [InvoiceCommand]')
      } finally {
        await workspace.cleanup()
      }
    })

    it('does not reach into the module from src/console.ts', async () => {
      const workspace = await createTempWorkspace('guren-cli-cmd-register-module-boundary-')
      try {
        await writeConsoleEntry(workspace.dir)
        await writeModuleIndex(workspace.dir)

        await scaffoldAndRegister('Invoice', { root: 'billing' })

        // A deep import into modules/billing/app/... would fail `guren check
        // --arch`; the module's descriptor is the only surface touched.
        const consoleSource = await readFile(join(workspace.dir, 'src/console.ts'), 'utf8')
        expect(consoleSource).not.toContain('modules/billing/app')
        expect(consoleSource).not.toContain('InvoiceCommand')
      } finally {
        await workspace.cleanup()
      }
    })
  })
})
