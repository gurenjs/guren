import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { addImport, addProvider, hasImport, hasAuthProvider, ensureDrizzleImports, ensureMysqlImports, ensureNamedImports, ensureSqliteImports } from './patch-helpers'

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
      const initialContent = `import { Application } from '@guren/core'
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
      const initialContent = `import { Application } from '@guren/core'
import { createSessionMiddleware } from '@guren/core'

const app = new Application()`

      await writeFile(filePath, initialContent, 'utf8')

      const result = await addImport(
        filePath,
        "import { createSessionMiddleware } from '@guren/core'",
      )

      expect(result.modified).toBe(false)
      expect(result.reason).toBe('Import already exists')
    })

    it('should return false if file not found', async () => {
      const result = await addImport(join(tempDir, 'nonexistent.ts'), "import { foo } from 'bar'")

      expect(result.modified).toBe(false)
      expect(result.reason).toBe('File not found')
    })

    it('should insert after a multi-line import statement, not inside it', async () => {
      const filePath = join(tempDir, 'app.ts')
      const initialContent = `import {
  createApp,
  ErrorServiceProvider,
  InertiaServiceProvider,
} from '@guren/core'
import DatabaseProvider from '../app/Providers/DatabaseProvider.js'

const app = createApp({})`

      await writeFile(filePath, initialContent, 'utf8')

      const result = await addImport(filePath, "import { billingModule } from '../modules/billing'")

      expect(result.modified).toBe(true)

      const content = await Bun.file(filePath).text()
      const lines = content.split('\n')

      // The multi-line import block must stay intact and syntactically valid —
      // the new import must not be spliced between `import {` and its closing `}`.
      expect(lines[0]).toBe('import {')
      expect(lines[1]).toBe('  createApp,')
      expect(lines.slice(0, 5).join('\n')).toContain("} from '@guren/core'")
      expect(content.indexOf("import { billingModule } from '../modules/billing'")).toBeGreaterThan(
        content.indexOf("} from '@guren/core'"),
      )
    })

    it('should insert after the last of several imports, some multi-line', async () => {
      const filePath = join(tempDir, 'app.ts')
      const initialContent = `import {
  createApp,
  ErrorServiceProvider,
} from '@guren/core'
import DatabaseProvider from '../app/Providers/DatabaseProvider.js'
import AuthProvider from '../app/Providers/AuthProvider.js'

const app = createApp({})`

      await writeFile(filePath, initialContent, 'utf8')

      const result = await addImport(filePath, "import { billingModule } from '../modules/billing'")

      expect(result.modified).toBe(true)

      const content = await Bun.file(filePath).text()
      expect(content.indexOf("import { billingModule } from '../modules/billing'")).toBeGreaterThan(
        content.indexOf("import AuthProvider from '../app/Providers/AuthProvider.js'"),
      )
      expect(content.indexOf("import { billingModule } from '../modules/billing'")).toBeLessThan(
        content.indexOf('const app = createApp({})'),
      )
    })
  })

  describe('addProvider', () => {
    it('should add provider to providers array', async () => {
      const filePath = join(tempDir, 'app.ts')
      const initialContent = `import { Application } from '@guren/core'
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
      const initialContent = `import { Application } from '@guren/core'
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
      const initialContent = `import { Application } from '@guren/core'

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
        "import { Application } from '@guren/core'\n\nconst app = new Application()",
        'utf8',
      )

      const result = await hasImport(filePath, "import { Application } from '@guren/core'")

      expect(result).toBe(true)
    })

    it('should return false if import does not exist', async () => {
      const filePath = join(tempDir, 'test.ts')
      await writeFile(filePath, "import { Application } from '@guren/core'", 'utf8')

      const result = await hasImport(filePath, "import { foo } from 'bar'")

      expect(result).toBe(false)
    })

    it('should return false if file not found', async () => {
      const result = await hasImport(join(tempDir, 'nonexistent.ts'), "import { foo } from 'bar'")

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

  describe('ensureDrizzleImports', () => {
    it('should add missing imports when no Drizzle import exists', () => {
      const content = `const x = 1\n`
      const result = ensureDrizzleImports(content, ['pgTable', 'serial', 'text'])

      expect(result).toContain("import { pgTable, serial, text } from '@guren/orm/drizzle'")
      expect(result).toContain('const x = 1')
    })

    it('should merge into existing Drizzle import', () => {
      const content = `import { pgTable, serial } from '@guren/orm/drizzle'\n\nexport const posts = pgTable('posts', {})\n`
      const result = ensureDrizzleImports(content, ['pgTable', 'serial', 'text', 'timestamp'])

      expect(result).toContain("import { pgTable, serial, text, timestamp } from '@guren/orm/drizzle'")
      expect(result).not.toContain("import { pgTable, serial }")
    })

    it('should not modify content when all imports already present', () => {
      const content = `import { pgTable, serial, text, timestamp } from '@guren/orm/drizzle'\n\nexport const posts = pgTable('posts', {})\n`
      const result = ensureDrizzleImports(content, ['pgTable', 'serial', 'text', 'timestamp'])

      expect(result).toBe(content)
    })

    it('should return content unchanged when needed list is empty', () => {
      const content = `const x = 1\n`
      const result = ensureDrizzleImports(content, [])

      expect(result).toBe(content)
    })
  })

  describe('ensureSqliteImports', () => {
    it('should add missing imports when no SQLite import exists', () => {
      const content = `const x = 1\n`
      const result = ensureSqliteImports(content, ['sqliteTable', 'integer', 'text'])

      expect(result).toContain("import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'")
      expect(result).toContain('const x = 1')
    })

    it('should merge into existing SQLite import', () => {
      const content = `import { sqliteTable, integer } from 'drizzle-orm/sqlite-core'\n\nexport const users = sqliteTable('users', {})\n`
      const result = ensureSqliteImports(content, ['sqliteTable', 'integer', 'text'])

      expect(result).toContain("import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'")
      expect(result).not.toContain("import { sqliteTable, integer }")
    })

    it('should not modify content when all imports already present', () => {
      const content = `import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'\n\nexport const users = sqliteTable('users', {})\n`
      const result = ensureSqliteImports(content, ['sqliteTable', 'integer', 'text'])

      expect(result).toBe(content)
    })

    it('should return content unchanged when needed list is empty', () => {
      const content = `const x = 1\n`
      const result = ensureSqliteImports(content, [])

      expect(result).toBe(content)
    })
  })

  describe('ensureMysqlImports', () => {
    // The header `create-guren-app --db mysql` scaffolds.
    const scaffoldedSchema = `import { mysqlTable, int, varchar, timestamp } from 'drizzle-orm/mysql-core'\n\nexport const users = mysqlTable('users', {})\n`

    it('should add missing imports when no MySQL import exists', () => {
      const content = `const x = 1\n`
      const result = ensureMysqlImports(content, ['mysqlTable', 'int', 'varchar'])

      expect(result).toContain("import { int, mysqlTable, varchar } from 'drizzle-orm/mysql-core'")
      expect(result).toContain('const x = 1')
    })

    it('should merge new column builders into the scaffolded MySQL import', () => {
      const result = ensureMysqlImports(scaffoldedSchema, ['mysqlTable', 'int', 'timestamp', 'boolean'])

      expect(result).toContain(
        "import { boolean, int, mysqlTable, timestamp, varchar } from 'drizzle-orm/mysql-core'",
      )
      // One import line, not a second one appended alongside it.
      expect(result.match(/^import /gmu)).toHaveLength(1)
    })

    it('should not modify content when all imports already present', () => {
      const result = ensureMysqlImports(scaffoldedSchema, ['mysqlTable', 'int', 'varchar', 'timestamp'])

      expect(result).toBe(scaffoldedSchema)
    })

    it('should return content unchanged when needed list is empty', () => {
      const content = `const x = 1\n`
      const result = ensureMysqlImports(content, [])

      expect(result).toBe(content)
    })

    // Documents why the mysql scaffold must not import from
    // `@guren/orm/drizzle`: the merge is not module-scoped, so a same-named
    // builder already in scope from another dialect satisfies the requirement
    // and the MySQL one is never imported. Scoping the match per module would
    // be an improvement — update this test rather than treating it as a
    // regression.
    it('should not re-import a name another module already brought into scope', () => {
      const mixed = `import { mysqlTable, int, varchar, timestamp } from '@guren/orm/drizzle'\n\nexport const users = mysqlTable('users', {})\n`
      const result = ensureMysqlImports(mixed, ['mysqlTable', 'int', 'varchar', 'timestamp'])

      expect(result).toBe(mixed)
    })
  })

  describe('ensureNamedImports', () => {
    // The three dialect wrappers pass fixed, `$`-free specifiers, so only a
    // direct caller can hit this. `$&` is special inside a replacement
    // string — merging must insert the specifier literally instead.
    it('should insert a specifier containing replacement patterns literally', () => {
      const content = `import { a } from '$&/pkg'\n\nconst x = 1\n`
      const result = ensureNamedImports(content, '$&/pkg', ['a', 'b'])

      expect(result).toBe(`import { a, b } from '$&/pkg'\n\nconst x = 1\n`)
    })
  })
})
