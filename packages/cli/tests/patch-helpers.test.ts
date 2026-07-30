import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { addImport, addToArrayArgument, addToArrayOption } from '../src/patch-helpers'
import { createTempWorkspace } from './helpers'

describe('addImport', () => {
  it('inserts after a single-line leading import', async () => {
    const workspace = await createTempWorkspace('guren-cli-add-import-')
    try {
      const target = join(workspace.dir, 'app.ts')
      await writeFile(
        target,
        `import { createApp } from '@guren/core'
import DatabaseProvider from '../app/Providers/DatabaseProvider.js'

const app = createApp({})
`,
        'utf8',
      )

      const result = await addImport('app.ts', "import MailProvider from '../app/Providers/MailProvider.js'")
      expect(result.modified).toBe(true)

      const content = await readFile(target, 'utf8')
      expect(content).toContain(
        "import DatabaseProvider from '../app/Providers/DatabaseProvider.js'\nimport MailProvider from '../app/Providers/MailProvider.js'\n\nconst app",
      )
    } finally {
      await workspace.cleanup()
    }
  })

  it('does not insert inside a multi-line leading import', async () => {
    const workspace = await createTempWorkspace('guren-cli-add-import-multiline-')
    try {
      const target = join(workspace.dir, 'app.ts')
      await writeFile(
        target,
        `import {
  createApp,
  ErrorServiceProvider,
  InertiaServiceProvider,
} from '@guren/core'
import DatabaseProvider from '../app/Providers/DatabaseProvider.js'
import AuthProvider from '../app/Providers/AuthProvider.js'

const app = createApp({})
`,
        'utf8',
      )

      const result = await addImport('app.ts', "import MailProvider from '../app/Providers/MailProvider.js'")
      expect(result.modified).toBe(true)

      const content = await readFile(target, 'utf8')

      // The multi-line import block must stay intact.
      expect(content).toContain(`import {
  createApp,
  ErrorServiceProvider,
  InertiaServiceProvider,
} from '@guren/core'`)

      // The new import lands after the last import, not inside the block.
      expect(content).toContain(
        "import AuthProvider from '../app/Providers/AuthProvider.js'\nimport MailProvider from '../app/Providers/MailProvider.js'\n\nconst app",
      )

      // Sanity check: every line inside the multi-line block is still
      // valid — no import statement got spliced between `{` and `}`.
      const lines = content.split('\n')
      const openIndex = lines.indexOf('import {')
      const closeIndex = lines.findIndex((line) => line.startsWith('} from'))
      for (let i = openIndex + 1; i < closeIndex; i++) {
        expect(lines[i].trim().startsWith('import ')).toBe(false)
      }
    } finally {
      await workspace.cleanup()
    }
  })

  it('inserts after a trailing multi-line import that is not first', async () => {
    const workspace = await createTempWorkspace('guren-cli-add-import-trailing-multiline-')
    try {
      const target = join(workspace.dir, 'app.ts')
      await writeFile(
        target,
        `import DatabaseProvider from '../app/Providers/DatabaseProvider.js'
import {
  createApp,
  ErrorServiceProvider,
} from '@guren/core'

const app = createApp({})
`,
        'utf8',
      )

      const result = await addImport('app.ts', "import MailProvider from '../app/Providers/MailProvider.js'")
      expect(result.modified).toBe(true)

      const content = await readFile(target, 'utf8')
      expect(content).toContain(`} from '@guren/core'\nimport MailProvider from '../app/Providers/MailProvider.js'\n\nconst app`)
    } finally {
      await workspace.cleanup()
    }
  })

  it('treats a side-effect import as a complete single line', async () => {
    const workspace = await createTempWorkspace('guren-cli-add-import-side-effect-')
    try {
      const target = join(workspace.dir, 'app.ts')
      await writeFile(
        target,
        `import '../config/inertia.js'

const app = {}
`,
        'utf8',
      )

      const result = await addImport('app.ts', "import MailProvider from '../app/Providers/MailProvider.js'")
      expect(result.modified).toBe(true)

      const content = await readFile(target, 'utf8')
      expect(content).toContain("import '../config/inertia.js'\nimport MailProvider from '../app/Providers/MailProvider.js'\n\nconst app")
    } finally {
      await workspace.cleanup()
    }
  })

  it('is a no-op when the import already exists', async () => {
    const workspace = await createTempWorkspace('guren-cli-add-import-existing-')
    try {
      const target = join(workspace.dir, 'app.ts')
      await writeFile(target, "import AuthProvider from '../app/Providers/AuthProvider.js'\n", 'utf8')

      const result = await addImport('app.ts', "import AuthProvider from '../app/Providers/AuthProvider.js'")
      expect(result.modified).toBe(false)
      expect(result.reason).toBe('Import already exists')
    } finally {
      await workspace.cleanup()
    }
  })
})

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

describe('addToArrayArgument', () => {
  async function withConsole(contents: string, run: () => Promise<void>): Promise<string> {
    const workspace = await createTempWorkspace('guren-cli-array-argument-')
    try {
      await mkdir(join(workspace.dir, 'src'), { recursive: true })
      await writeFile(join(workspace.dir, 'src/console.ts'), contents, 'utf8')
      await run()
      return await readFile(join(workspace.dir, 'src/console.ts'), 'utf8')
    } finally {
      await workspace.cleanup()
    }
  }

  it('appends to an empty array literal', async () => {
    const result = await withConsole('kernel.registerMany([])\n', async () => {
      expect((await addToArrayArgument('src/console.ts', 'registerMany', 'Alpha')).modified).toBe(true)
    })
    expect(result).toBe('kernel.registerMany([Alpha])\n')
  })

  it('skips a call that only appears in a comment', async () => {
    const source = `// kernel.registerMany([Disabled])
/**
 * kernel.registerMany([Documented])
 */
kernel.registerMany([Real])
`
    const result = await withConsole(source, async () => {
      expect((await addToArrayArgument('src/console.ts', 'registerMany', 'Alpha')).modified).toBe(true)
    })
    expect(result).toContain('// kernel.registerMany([Disabled])')
    expect(result).toContain(' * kernel.registerMany([Documented])')
    expect(result).toContain('kernel.registerMany([Real, Alpha])')
  })

  it('is not fooled by a URL earlier on the same line', async () => {
    const result = await withConsole(`const docs = 'https://guren.dev'; kernel.registerMany([])\n`, async () => {
      expect((await addToArrayArgument('src/console.ts', 'registerMany', 'Alpha')).modified).toBe(true)
    })
    expect(result).toContain('kernel.registerMany([Alpha])')
  })

  it('appends before a trailing comment rather than into it', async () => {
    const source = `kernel.registerMany([
  Existing, // primary
])
`
    const result = await withConsole(source, async () => {
      await addToArrayArgument('src/console.ts', 'registerMany', 'Alpha')
    })
    expect(result).toContain('Existing, Alpha, // primary')
  })

  it('appends at the top level of a nested array', async () => {
    const result = await withConsole('kernel.registerMany([Basic, ...(dev ? [Dev] : [])])\n', async () => {
      await addToArrayArgument('src/console.ts', 'registerMany', 'Alpha')
    })
    expect(result).toBe('kernel.registerMany([Basic, ...(dev ? [Dev] : []), Alpha])\n')
  })

  it('leaves a call whose argument is not an array literal alone', async () => {
    const source = `kernel.registerMany(billingModule.commands)
kernel.registerMany([Real])
`
    const result = await withConsole(source, async () => {
      await addToArrayArgument('src/console.ts', 'registerMany', 'Alpha')
    })
    expect(result).toContain('kernel.registerMany(billingModule.commands)')
    expect(result).toContain('kernel.registerMany([Real, Alpha])')
  })

  it('reports Already present without rewriting the file', async () => {
    const source = 'kernel.registerMany([\n  Alpha,\n])\n'
    const result = await withConsole(source, async () => {
      expect((await addToArrayArgument('src/console.ts', 'registerMany', 'Alpha')).reason).toBe('Already present')
    })
    expect(result).toBe(source)
  })
})
