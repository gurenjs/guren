import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  addImport,
  addMiddleware,
  addProvider,
  hasImport,
  hasSessionMiddleware,
  hasAuthProvider,
} from './patch-helpers'

describe('patch-helpers', () => {
  let tempDir: string

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'guren-cli-test-'))
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  describe('addImport', () => {
    it('should add import to empty file', async () => {
      const filePath = join(tempDir, 'test.ts')
      await writeFile(filePath, '', 'utf8')

      const result = await addImport(filePath, "import { foo } from 'bar'")

      expect(result.modified).toBe(true)
      expect(result.reason).toBeUndefined()
    })

    it('should add import after existing imports', async () => {
      const filePath = join(tempDir, 'test.ts')
      const initialContent = `import { Application } from '@guren/server'
import { something } from 'else'

const app = new Application()`

      await writeFile(filePath, initialContent, 'utf8')

      const result = await addImport(filePath, "import { newThing } from 'new'")

      expect(result.modified).toBe(true)

      const content = await Bun.file(filePath).text()
      expect(content).toContain("import { newThing } from 'new'")
      expect(content.indexOf("import { newThing } from 'new'")).toBeGreaterThan(
        content.indexOf("import { something } from 'else'"),
      )
    })

    it('should not add duplicate import', async () => {
      const filePath = join(tempDir, 'test.ts')
      const initialContent = `import { Application } from '@guren/server'
import { createSessionMiddleware } from '@guren/server'

const app = new Application()`

      await writeFile(filePath, initialContent, 'utf8')

      const result = await addImport(
        filePath,
        "import { createSessionMiddleware } from '@guren/server'",
      )

      expect(result.modified).toBe(false)
      expect(result.reason).toBe('Import already exists')
    })

    it('should return false if file not found', async () => {
      const result = await addImport(join(tempDir, 'nonexistent.ts'), "import { foo } from 'bar'")

      expect(result.modified).toBe(false)
      expect(result.reason).toBe('File not found')
    })
  })

  describe('addMiddleware', () => {
    it('should add session middleware before auth context', async () => {
      const filePath = join(tempDir, 'app.ts')
      const initialContent = `import { Application } from '@guren/server'

const app = new Application({
  providers: [],
})

app.use('*', attachAuthContext((ctx) => app.auth.createAuthContext(ctx)))`

      await writeFile(filePath, initialContent, 'utf8')

      const result = await addMiddleware(
        filePath,
        "app.use('*', createSessionMiddleware({ cookieSecure: false }))",
      )

      expect(result.modified).toBe(true)

      const content = await Bun.file(filePath).text()
      expect(content).toContain('createSessionMiddleware')
      expect(content.indexOf('createSessionMiddleware')).toBeLessThan(
        content.indexOf('attachAuthContext'),
      )
    })

    it('should not add duplicate session middleware', async () => {
      const filePath = join(tempDir, 'app.ts')
      const initialContent = `import { Application, createSessionMiddleware } from '@guren/server'

const app = new Application()

app.use('*', createSessionMiddleware({ cookieSecure: false }))
app.use('*', attachAuthContext((ctx) => app.auth.createAuthContext(ctx)))`

      await writeFile(filePath, initialContent, 'utf8')

      const result = await addMiddleware(
        filePath,
        "app.use('*', createSessionMiddleware({ cookieSecure: false }))",
      )

      expect(result.modified).toBe(false)
      expect(result.reason).toBe('Middleware already registered')
    })

    it('should return false if file not found', async () => {
      const result = await addMiddleware(
        join(tempDir, 'nonexistent.ts'),
        "app.use('*', createSessionMiddleware())",
      )

      expect(result.modified).toBe(false)
      expect(result.reason).toBe('File not found')
    })
  })

  describe('addProvider', () => {
    it('should add provider to providers array', async () => {
      const filePath = join(tempDir, 'app.ts')
      const initialContent = `import { Application } from '@guren/server'
import DatabaseProvider from './Providers/DatabaseProvider.js'

const app = new Application({
  providers: [DatabaseProvider],
})`

      await writeFile(filePath, initialContent, 'utf8')

      const result = await addProvider(filePath, 'AuthProvider')

      expect(result.modified).toBe(true)

      const content = await Bun.file(filePath).text()
      expect(content).toContain('AuthProvider')
      expect(content).toMatch(/providers:\s*\[.*DatabaseProvider.*AuthProvider.*\]/)
    })

    it('should not add duplicate provider', async () => {
      const filePath = join(tempDir, 'app.ts')
      const initialContent = `import { Application } from '@guren/server'
import AuthProvider from './Providers/AuthProvider.js'

const app = new Application({
  providers: [AuthProvider],
})`

      await writeFile(filePath, initialContent, 'utf8')

      const result = await addProvider(filePath, 'AuthProvider')

      expect(result.modified).toBe(false)
      expect(result.reason).toBe('Provider already registered')
    })

    it('should return false if providers array not found', async () => {
      const filePath = join(tempDir, 'app.ts')
      const initialContent = `import { Application } from '@guren/server'

const app = new Application()`

      await writeFile(filePath, initialContent, 'utf8')

      const result = await addProvider(filePath, 'AuthProvider')

      expect(result.modified).toBe(false)
      expect(result.reason).toBe('Could not find providers array')
    })
  })

  describe('hasImport', () => {
    it('should return true if import exists', async () => {
      const filePath = join(tempDir, 'test.ts')
      await writeFile(
        filePath,
        "import { Application } from '@guren/server'\n\nconst app = new Application()",
        'utf8',
      )

      const result = await hasImport(filePath, "import { Application } from '@guren/server'")

      expect(result).toBe(true)
    })

    it('should return false if import does not exist', async () => {
      const filePath = join(tempDir, 'test.ts')
      await writeFile(filePath, "import { Application } from '@guren/server'", 'utf8')

      const result = await hasImport(filePath, "import { foo } from 'bar'")

      expect(result).toBe(false)
    })

    it('should return false if file not found', async () => {
      const result = await hasImport(join(tempDir, 'nonexistent.ts'), "import { foo } from 'bar'")

      expect(result).toBe(false)
    })
  })

  describe('hasSessionMiddleware', () => {
    it('should return true if session middleware exists', async () => {
      const filePath = join(tempDir, 'app.ts')
      await writeFile(
        filePath,
        "app.use('*', createSessionMiddleware({ cookieSecure: false }))",
        'utf8',
      )

      const result = await hasSessionMiddleware(filePath)

      expect(result).toBe(true)
    })

    it('should return false if session middleware does not exist', async () => {
      const filePath = join(tempDir, 'app.ts')
      await writeFile(filePath, "app.use('*', someOtherMiddleware())", 'utf8')

      const result = await hasSessionMiddleware(filePath)

      expect(result).toBe(false)
    })
  })

  describe('hasAuthProvider', () => {
    it('should return true if AuthProvider exists', async () => {
      const filePath = join(tempDir, 'app.ts')
      await writeFile(
        filePath,
        'const app = new Application({ providers: [AuthProvider] })',
        'utf8',
      )

      const result = await hasAuthProvider(filePath)

      expect(result).toBe(true)
    })

    it('should return false if AuthProvider does not exist', async () => {
      const filePath = join(tempDir, 'app.ts')
      await writeFile(
        filePath,
        'const app = new Application({ providers: [DatabaseProvider] })',
        'utf8',
      )

      const result = await hasAuthProvider(filePath)

      expect(result).toBe(false)
    })
  })
})
