import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { addToArrayOption } from '../src/patch-helpers'
import { createTempWorkspace } from './helpers'

describe('addToArrayOption', () => {
  it('creates the option when it is absent entirely', async () => {
    const workspace = await createTempWorkspace('guren-cli-patch-array-create-')
    try {
      await mkdir(join(workspace.dir, 'src'), { recursive: true })
      await writeFile(
        join(workspace.dir, 'src/app.ts'),
        `import { createApp } from '@guren/core'

const app = createApp({
  routes: registerWebRoutes,
})
`,
        'utf8',
      )

      const result = await addToArrayOption('src/app.ts', 'modules', 'billingModule')
      expect(result.modified).toBe(true)

      const content = await readFile(join(workspace.dir, 'src/app.ts'), 'utf8')
      expect(content).toContain('modules: [billingModule]')
    } finally {
      await workspace.cleanup()
    }
  })

  it('appends to an existing array', async () => {
    const workspace = await createTempWorkspace('guren-cli-patch-array-append-')
    try {
      await mkdir(join(workspace.dir, 'src'), { recursive: true })
      await writeFile(
        join(workspace.dir, 'src/app.ts'),
        `import { createApp } from '@guren/core'

const app = createApp({
  routes: registerWebRoutes,
  modules: [inventoryModule],
})
`,
        'utf8',
      )

      const result = await addToArrayOption('src/app.ts', 'modules', 'billingModule')
      expect(result.modified).toBe(true)

      const content = await readFile(join(workspace.dir, 'src/app.ts'), 'utf8')
      expect(content).toContain('modules: [inventoryModule, billingModule]')
    } finally {
      await workspace.cleanup()
    }
  })

  it('is a no-op when the entry is already present', async () => {
    const workspace = await createTempWorkspace('guren-cli-patch-array-dup-')
    try {
      await mkdir(join(workspace.dir, 'src'), { recursive: true })
      await writeFile(
        join(workspace.dir, 'src/app.ts'),
        `import { createApp } from '@guren/core'

const app = createApp({
  modules: [billingModule],
})
`,
        'utf8',
      )

      const result = await addToArrayOption('src/app.ts', 'modules', 'billingModule')
      expect(result.modified).toBe(false)
      expect(result.reason).toBe('Already present')
    } finally {
      await workspace.cleanup()
    }
  })

  it('returns a not-found result for a missing file', async () => {
    const workspace = await createTempWorkspace('guren-cli-patch-array-missing-')
    try {
      const result = await addToArrayOption('src/app.ts', 'modules', 'billingModule')
      expect(result.modified).toBe(false)
      expect(result.reason).toBe('File not found')
    } finally {
      await workspace.cleanup()
    }
  })

  it('creating the option fails gracefully when there is no createApp() call', async () => {
    const workspace = await createTempWorkspace('guren-cli-patch-array-no-createapp-')
    try {
      await mkdir(join(workspace.dir, 'src'), { recursive: true })
      await writeFile(join(workspace.dir, 'src/app.ts'), `export const notAnApp = {}\n`, 'utf8')

      const result = await addToArrayOption('src/app.ts', 'modules', 'billingModule')
      expect(result.modified).toBe(false)
      expect(result.reason).toBe('Could not find a createApp({ ... }) call')
    } finally {
      await workspace.cleanup()
    }
  })
})
