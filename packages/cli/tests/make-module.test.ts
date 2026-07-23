import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { makeModule } from '../src/make-module'
import { createTempWorkspace } from './helpers'

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

      // Nothing should have been written outside the workspace.
      const escaped = await readFile(join(workspace.dir, '../../outside/index.ts'), 'utf8').catch(() => null)
      expect(escaped).toBeNull()
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

  it('skips schema patching when the project has no db/schema.ts', async () => {
    const workspace = await createTempWorkspace('guren-cli-make-module-no-schema-')
    try {
      const { filesCreated } = await makeModule('billing')
      expect(filesCreated).toHaveLength(3)
      // No assertion on db/schema.ts content — it simply doesn't exist to patch.
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
