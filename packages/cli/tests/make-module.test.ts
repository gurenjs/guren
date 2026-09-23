import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { makeModule } from '../src/make-module'
import { runCheck } from '../src/check'
import { captureWarnings, checkTypes, createTempWorkspace, PG_SCHEMA_FIXTURE, renderedAppCompilerOptions, TSC_TIMEOUT, writeWorkspaceFiles } from './helpers'

describe('makeModule', () => {
  it('scaffolds index.ts, routes.ts, and db/schema.ts', async () => {
    const workspace = await createTempWorkspace('guren-cli-make-module-basic-')
    try {
      const { moduleDir, filesCreated } = await makeModule('billing')

      expect(moduleDir).toBe('modules/billing')
      expect(filesCreated).toHaveLength(3)

      const index = await readFile(join(workspace.dir, 'modules/billing/index.ts'), 'utf8')
      expect(index).toContain("import { defineModule } from '@guren/core'")
      expect(index).toContain('export const billingModule = defineModule({')
      expect(index).toContain("name: 'billing'")
      expect(index).toContain("prefix: '/billing'")
      expect(index).toContain('routes: registerBillingRoutes')

      const routes = await readFile(join(workspace.dir, 'modules/billing/routes.ts'), 'utf8')
      expect(routes).toContain('export function registerBillingRoutes(router: Router): void {')

      const schema = await readFile(join(workspace.dir, 'modules/billing/db/schema.ts'), 'utf8')
      expect(schema).toContain("Define this module's Drizzle tables")
    } finally {
      await workspace.cleanup()
    }
  })

  it('kebab-cases a PascalCase module name for the directory and identifiers', async () => {
    const workspace = await createTempWorkspace('guren-cli-make-module-pascal-')
    try {
      const { moduleDir } = await makeModule('Billing')
      expect(moduleDir).toBe('modules/billing')

      const index = await readFile(join(workspace.dir, 'modules/billing/index.ts'), 'utf8')
      expect(index).toContain('export const billingModule')
      expect(index).toContain('registerBillingRoutes')
    } finally {
      await workspace.cleanup()
    }
  })

  it('rejects a module name that would escape modules/ (path traversal)', async () => {
    const workspace = await createTempWorkspace('guren-cli-make-module-traversal-')
    try {
      await expect(makeModule('../../outside')).rejects.toThrow(/Invalid module name/)

      const escaped = await readFile(join(workspace.dir, '../../outside/index.ts'), 'utf8').catch(() => null)
      expect(escaped).toBeNull()
    } finally {
      await workspace.cleanup()
    }
  })

  it('rejects a module name starting with a digit', async () => {
    const workspace = await createTempWorkspace('guren-cli-make-module-digit-')
    try {
      // `modules/2fa/` would be PascalCased into `2faInvoice` by codegen.
      await expect(makeModule('2fa')).rejects.toThrow(/Invalid module name/)

      const created = await readFile(join(workspace.dir, 'modules/2fa/index.ts'), 'utf8').catch(() => null)
      expect(created).toBeNull()
    } finally {
      await workspace.cleanup()
    }
  })

  it('patches an existing db/schema.ts with a re-export', async () => {
    const workspace = await createTempWorkspace('guren-cli-make-module-schema-patch-')
    try {
      await mkdir(join(workspace.dir, 'db'), { recursive: true })
      await writeFile(join(workspace.dir, 'db/schema.ts'), `import { sqliteTable } from 'drizzle-orm/sqlite-core'\n`, 'utf8')

      await makeModule('billing')

      const schema = await readFile(join(workspace.dir, 'db/schema.ts'), 'utf8')
      expect(schema).toContain("export * from '../modules/billing/db/schema'")
    } finally {
      await workspace.cleanup()
    }
  })

  it('leaves the module schema a bare module when the root keeps no schema object', async () => {
    const workspace = await createTempWorkspace('guren-cli-make-module-no-aggregate-')
    try {
      await writeWorkspaceFiles(workspace.dir, { 'db/schema.ts': PG_SCHEMA_FIXTURE })

      await makeModule('billing')

      expect(await readFile(join(workspace.dir, 'modules/billing/db/schema.ts'), 'utf8')).toContain('export {}')
      expect(await readFile(join(workspace.dir, 'db/schema.ts'), 'utf8')).not.toContain('billingSchema')
    } finally {
      await workspace.cleanup()
    }
  })

  it(
    'gives the module an aggregate the root schema object spreads, and check holds both to their tables',
    async () => {
      const workspace = await createTempWorkspace('guren-cli-make-module-aggregate-')
      const aggregateCheck = async (scope: string) =>
        (await runCheck({ cwd: workspace.dir })).checks.find((c) => c.key === `schema-aggregate-keys:${scope}`)
      try {
        await writeWorkspaceFiles(workspace.dir, { 'db/schema.ts': `${PG_SCHEMA_FIXTURE}\nexport const schema = { users }\n` })

        await makeModule('Billing')

        const root = await readFile(join(workspace.dir, 'db/schema.ts'), 'utf8')
        expect(root).toContain("import { billingSchema } from '../modules/billing/db/schema'")
        expect(root).toContain('export const schema = { users, ...billingSchema }')
        expect(await readFile(join(workspace.dir, 'modules/billing/db/schema.ts'), 'utf8')).toContain('export const billingSchema = {}')
        expect((await aggregateCheck('app'))!.status).toBe('pass')

        // The author's next step: a table the module declares and forgets to list.
        const moduleSchema = `import { pgTable, serial } from '@guren/orm/drizzle/pg'

export const invoices = pgTable('invoices', {
  id: serial('id').primaryKey(),
})

export const billingSchema = {}
`
        await writeWorkspaceFiles(workspace.dir, { 'modules/billing/db/schema.ts': moduleSchema })
        const unlisted = await aggregateCheck('billing')
        expect(unlisted!.status).toBe('warn')
        expect(unlisted!.advisory).toBe(false)
        expect(unlisted!.message).toContain('invoices')

        await writeWorkspaceFiles(workspace.dir, { 'modules/billing/db/schema.ts': moduleSchema.replace('billingSchema = {}', 'billingSchema = { invoices }') })
        expect((await aggregateCheck('billing'))!.status).toBe('pass')
        expect((await aggregateCheck('app'))!.status).toBe('pass')
        const program = ['db/schema.ts', 'modules/billing/db/schema.ts'].map((file) => join(workspace.dir, file))
        expect(checkTypes(program, renderedAppCompilerOptions(workspace.dir))).toEqual([])

        await writeWorkspaceFiles(workspace.dir, { 'db/schema.ts': root.replace(', ...billingSchema', '') })
        const unspread = await aggregateCheck('app')
        expect(unspread!.status).toBe('warn')
        expect(unspread!.message).toContain('invoices (modules/billing/db/schema.ts)')
      } finally {
        await workspace.cleanup()
      }
    },
    TSC_TIMEOUT,
  )

  it('skips schema patching when the project has no db/schema.ts', async () => {
    const workspace = await createTempWorkspace('guren-cli-make-module-no-schema-')
    try {
      const { filesCreated } = await makeModule('billing')
      expect(filesCreated).toHaveLength(3)
    } finally {
      await workspace.cleanup()
    }
  })

  it('patches src/app.ts with an import and a modules array entry', async () => {
    const workspace = await createTempWorkspace('guren-cli-make-module-app-patch-')
    try {
      await mkdir(join(workspace.dir, 'src'), { recursive: true })
      await writeFile(
        join(workspace.dir, 'src/app.ts'),
        `import { createApp } from '@guren/core'
import registerWebRoutes from '../routes/web.js'

const app = createApp({
  routes: registerWebRoutes,
})

export default app
`,
        'utf8',
      )

      await makeModule('billing')

      const appContent = await readFile(join(workspace.dir, 'src/app.ts'), 'utf8')
      expect(appContent).toContain("import { billingModule } from '../modules/billing'")
      expect(appContent).toContain('modules: [billingModule]')
    } finally {
      await workspace.cleanup()
    }
  })

  it('appends to an existing modules array in src/app.ts', async () => {
    const workspace = await createTempWorkspace('guren-cli-make-module-app-append-')
    try {
      await mkdir(join(workspace.dir, 'src'), { recursive: true })
      await writeFile(
        join(workspace.dir, 'src/app.ts'),
        `import { createApp } from '@guren/core'
import { inventoryModule } from '../modules/inventory'
import registerWebRoutes from '../routes/web.js'

const app = createApp({
  routes: registerWebRoutes,
  modules: [inventoryModule],
})

export default app
`,
        'utf8',
      )

      await makeModule('billing')

      const appContent = await readFile(join(workspace.dir, 'src/app.ts'), 'utf8')
      expect(appContent).toContain('modules: [inventoryModule, billingModule]')
    } finally {
      await workspace.cleanup()
    }
  })

  // An import of a binding nothing references is an unused local, so the app
  // stops compiling under noUnusedLocals (as `addArrayOptionRegistration` enforces).
  it('withholds the module import when the app entry cannot be patched', async () => {
    const workspace = await createTempWorkspace('guren-cli-make-module-unpatchable-')
    try {
      await mkdir(join(workspace.dir, 'src'), { recursive: true })
      const appSource = `import { Application } from '@guren/core'

const app = new Application()

export default app
`
      await writeFile(join(workspace.dir, 'src/app.ts'), appSource, 'utf8')

      const { warnings } = await captureWarnings(() => makeModule('billing'))

      expect(warnings.join('\n')).toContain('Could not register the module automatically')
      expect(await readFile(join(workspace.dir, 'src/app.ts'), 'utf8')).toBe(appSource)
    } finally {
      await workspace.cleanup()
    }
  })

  it('does not throw when src/app.ts is missing', async () => {
    const workspace = await createTempWorkspace('guren-cli-make-module-no-app-')
    try {
      const { filesCreated } = await makeModule('billing')
      expect(filesCreated).toHaveLength(3)
    } finally {
      await workspace.cleanup()
    }
  })
})
