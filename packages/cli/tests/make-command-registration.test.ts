import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, spyOn } from 'bun:test'
import { consola } from 'consola'
import { makeCommand, registerScaffoldedCommand } from '../src/make-command'
import { makeModule } from '../src/make-module'
import * as patchHelpers from '../src/patch-helpers'
import { PATCH_REASONS } from '../src/patch-helpers'
import { createTempWorkspace } from './helpers'

// The real scaffolded entrypoint, not a copy: a hand-copied fixture stops
// proving make:command can patch it the moment the template is edited.
const TEMPLATE_CONSOLE_ENTRY = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../create-app/templates/default/src/console.ts',
)

async function writeConsoleEntry(dir: string, contents?: string): Promise<void> {
  await mkdir(join(dir, 'src'), { recursive: true })
  await writeFile(join(dir, 'src/console.ts'), contents ?? (await readFile(TEMPLATE_CONSOLE_ENTRY, 'utf8')), 'utf8')
}

/** The module descriptor `make:module` itself writes, for the same reason. */
async function writeModuleIndex(): Promise<void> {
  await makeModule('billing')
}

async function scaffoldAndRegister(name: string, options: { root?: string } = {}): Promise<string> {
  const file = await makeCommand(name, options)
  await registerScaffoldedCommand(name, file, options)
  return file
}

/** `level: message` for every line the registration prints, in print order. */
async function registerAndCollect(name: string, options: { root?: string } = {}): Promise<string[]> {
  const lines: string[] = []
  const spies = (['info', 'success', 'warn'] as const).map((level) =>
    spyOn(consola, level).mockImplementation(((message: unknown) => {
      lines.push(`${level}: ${String(message)}`)
    }) as never),
  )
  try {
    await scaffoldAndRegister(name, options)
  } finally {
    for (const spy of spies) spy.mockRestore()
  }
  return lines
}

/**
 * `addImport` fails only as a value, and no file state reachable from a test
 * makes it fail after the registration patch on the same file has just
 * succeeded, so the failure is injected at the helper's own boundary.
 */
async function withFailingAddImport<T>(reason: string, run: () => Promise<T>): Promise<T> {
  const spy = spyOn(patchHelpers, 'addImport').mockResolvedValue({ modified: false, reason })
  try {
    return await run()
  } finally {
    spy.mockRestore()
  }
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

    it('prints the manual import step, not success, when the import patch fails', async () => {
      const workspace = await createTempWorkspace('guren-cli-cmd-register-import-fails-')
      try {
        await writeConsoleEntry(workspace.dir)

        const lines = await withFailingAddImport(PATCH_REASONS.fileNotFound, () => registerAndCollect('SendDigest'))

        expect(lines).toEqual([
          `warn: Could not add the import to src/console.ts automatically: ${PATCH_REASONS.fileNotFound}`,
          "info: Add `import SendDigestCommand from '../app/Console/Commands/SendDigestCommand.js'` to src/console.ts: its registration is already in place.",
        ])
        // The registration patch ran first and stays: the message has to describe that file.
        const consoleSource = await readFile(join(workspace.dir, 'src/console.ts'), 'utf8')
        expect(consoleSource).toContain('kernel.registerMany([SendDigestCommand])')
        expect(consoleSource).not.toContain('import SendDigestCommand')
      } finally {
        await workspace.cleanup()
      }
    })

    it('still reports success when the import was already there', async () => {
      const workspace = await createTempWorkspace('guren-cli-cmd-register-import-exists-')
      try {
        await writeConsoleEntry(
          workspace.dir,
          `import { ConsoleKernel } from '@guren/core'
import SendDigestCommand from '../app/Console/Commands/SendDigestCommand.js'

export const kernel = new ConsoleKernel()

kernel.registerMany([])
`,
        )

        const lines = await registerAndCollect('SendDigest')

        expect(lines).toEqual(['success: Registered SendDigestCommand in src/console.ts'])
        const consoleSource = await readFile(join(workspace.dir, 'src/console.ts'), 'utf8')
        expect(consoleSource.match(/import SendDigestCommand from/g)).toHaveLength(1)
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
        await writeModuleIndex()

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
        await writeModuleIndex()

        await scaffoldAndRegister('Invoice', { root: 'billing' })
        await scaffoldAndRegister('Dunning', { root: 'billing' })

        const index = await readFile(join(workspace.dir, 'modules/billing/index.ts'), 'utf8')
        expect(index).toContain('commands: [InvoiceCommand, DunningCommand]')
      } finally {
        await workspace.cleanup()
      }
    })

    it('prints the manual import step, not success, when the import patch fails', async () => {
      const workspace = await createTempWorkspace('guren-cli-cmd-register-module-import-fails-')
      try {
        await writeModuleIndex()

        const lines = await withFailingAddImport(PATCH_REASONS.fileNotFound, () => registerAndCollect('Invoice', { root: 'billing' }))

        expect(lines).toEqual([
          `warn: Could not add the import to modules/billing/index.ts automatically: ${PATCH_REASONS.fileNotFound}`,
          "info: Add `import InvoiceCommand from './app/Console/Commands/InvoiceCommand.js'` to modules/billing/index.ts: its registration is already in place.",
        ])
        const index = await readFile(join(workspace.dir, 'modules/billing/index.ts'), 'utf8')
        expect(index).toContain('commands: [InvoiceCommand]')
        expect(index).not.toContain('import InvoiceCommand')
      } finally {
        await workspace.cleanup()
      }
    })

    it('normalizes --module Billing to the same modules/billing descriptor', async () => {
      const workspace = await createTempWorkspace('guren-cli-cmd-register-module-case-')
      try {
        await writeModuleIndex()

        await scaffoldAndRegister('Invoice', { root: 'Billing' })

        const index = await readFile(join(workspace.dir, 'modules/billing/index.ts'), 'utf8')
        expect(index).toContain('commands: [InvoiceCommand]')
      } finally {
        await workspace.cleanup()
      }
    })

    it('scaffolds but does not invent an index when the module has none', async () => {
      const workspace = await createTempWorkspace('guren-cli-cmd-register-module-noindex-')
      try {
        const file = await scaffoldAndRegister('Invoice', { root: 'billing' })

        expect(file).toContain('modules/billing/app/Console/Commands/InvoiceCommand.ts')
        // Registration is skipped with printed guidance — writing a bare
        // index.ts here would clobber the module's public surface contract.
        const index = await readFile(join(workspace.dir, 'modules/billing/index.ts'), 'utf8').catch(() => null)
        expect(index).toBeNull()
      } finally {
        await workspace.cleanup()
      }
    })

    it('does not reach into the module from src/console.ts', async () => {
      const workspace = await createTempWorkspace('guren-cli-cmd-register-module-boundary-')
      try {
        await writeConsoleEntry(workspace.dir)
        await writeModuleIndex()

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
