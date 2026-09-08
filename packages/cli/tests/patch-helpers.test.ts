import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { parseSourceFile } from '../src/parse-cache'
import { addImport, addToArrayArgument, addToArrayOption, appendSchemaTable, insertImport, insertProvider, PATCH_REASONS } from '../src/patch-helpers'
import { captureWarnings, createTempWorkspace, PG_SCHEMA_FIXTURE, writeWorkspaceFiles } from './helpers'

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

      expect(content).toContain(`import {
  createApp,
  ErrorServiceProvider,
  InertiaServiceProvider,
} from '@guren/core'`)

      // The new import lands after the last import, not inside the block.
      expect(content).toContain(
        "import AuthProvider from '../app/Providers/AuthProvider.js'\nimport MailProvider from '../app/Providers/MailProvider.js'\n\nconst app",
      )

      // No import statement got spliced between `{` and `}`.
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

  it('does not match a longer method name ending in the target', async () => {
    const source = 'function unregisterMany(_: unknown[]) {}\nunregisterMany([])\n'
    const result = await withConsole(source, async () => {
      expect((await addToArrayArgument('src/console.ts', 'registerMany', 'Alpha')).modified).toBe(false)
    })
    expect(result).toBe(source)
  })

  it('edits a key whose colon is separated by a comment', async () => {
    const workspace = await createTempWorkspace('guren-cli-array-option-comment-')
    try {
      await writeFile(
        join(workspace.dir, 'mod.ts'),
        'export const m = defineModule({ name: "billing", commands /* note */: [Old] })\n',
        'utf8',
      )
      await addToArrayOption('mod.ts', 'commands', 'New', 'defineModule')
      const result = await readFile(join(workspace.dir, 'mod.ts'), 'utf8')
      expect(result).toContain('commands /* note */: [Old, New]')
    } finally {
      await workspace.cleanup()
    }
  })

  it('reports Already present without rewriting the file', async () => {
    const source = 'kernel.registerMany([\n  Alpha,\n])\n'
    const result = await withConsole(source, async () => {
      expect((await addToArrayArgument('src/console.ts', 'registerMany', 'Alpha')).reason).toBe('Already present')
    })
    expect(result).toBe(source)
  })
})

describe('addToArrayOption — call scoping', () => {
  it('edits the named call, not an earlier call with the same key', async () => {
    const workspace = await createTempWorkspace('guren-cli-array-option-scope-')
    try {
      // Under a file-global key search, analytics' array — the first
      // `commands: [...]` in the file — would be the one edited.
      await writeFile(
        join(workspace.dir, 'mod.ts'),
        `analytics({ commands: [Tracker] })
export const m = defineModule({ name: 'billing', commands: [Old] })
`,
        'utf8',
      )
      const result = await addToArrayOption('mod.ts', 'commands', 'New', 'defineModule')
      expect(result.modified).toBe(true)

      const content = await readFile(join(workspace.dir, 'mod.ts'), 'utf8')
      expect(content).toContain('analytics({ commands: [Tracker] })')
      expect(content).toContain("defineModule({ name: 'billing', commands: [Old, New] })")
    } finally {
      await workspace.cleanup()
    }
  })

  it('creates the option on the named call when only an unrelated call has the key', async () => {
    const workspace = await createTempWorkspace('guren-cli-array-option-scope-create-')
    try {
      await writeFile(
        join(workspace.dir, 'mod.ts'),
        `analytics({ commands: [Tracker] })
export const m = defineModule({ name: 'billing' })
`,
        'utf8',
      )
      const result = await addToArrayOption('mod.ts', 'commands', 'New', 'defineModule')
      expect(result.modified).toBe(true)

      const content = await readFile(join(workspace.dir, 'mod.ts'), 'utf8')
      expect(content).toContain('analytics({ commands: [Tracker] })')
      expect(content).toMatch(/defineModule\(\{\s*commands: \[New\],/)
    } finally {
      await workspace.cleanup()
    }
  })
})

describe('addToArrayArgument — safe declines', () => {
  it('declines without corrupting a file whose masking cannot be trusted', async () => {
    const workspace = await createTempWorkspace('guren-cli-array-argument-regex-')
    try {
      // A regex literal containing a quote defeats the string mask (telling a
      // regex from division needs a real lexer), so the contract is: decline
      // with a reason, never edit the wrong site.
      const source = "const apostrophe = /'/; kernel.registerMany([])\n"
      await mkdir(join(workspace.dir, 'src'), { recursive: true })
      await writeFile(join(workspace.dir, 'src/console.ts'), source, 'utf8')

      const result = await addToArrayArgument('src/console.ts', 'registerMany', 'Alpha')
      expect(result.modified).toBe(false)
      expect(result.reason).toContain('Could not find')
      expect(await readFile(join(workspace.dir, 'src/console.ts'), 'utf8')).toBe(source)
    } finally {
      await workspace.cleanup()
    }
  })

  it('appends into an empty multi-line array without touching its shape', async () => {
    const workspace = await createTempWorkspace('guren-cli-array-argument-empty-multiline-')
    try {
      await mkdir(join(workspace.dir, 'src'), { recursive: true })
      await writeFile(join(workspace.dir, 'src/console.ts'), 'kernel.registerMany([\n])\n', 'utf8')

      const result = await addToArrayArgument('src/console.ts', 'registerMany', 'Alpha')
      expect(result.modified).toBe(true)
      expect(await readFile(join(workspace.dir, 'src/console.ts'), 'utf8')).toBe('kernel.registerMany([Alpha\n])\n')
    } finally {
      await workspace.cleanup()
    }
  })
})

describe('insertImport — already-imported detection', () => {
  const STATEMENT = "import { registerAttachmentRoutes } from '@guren/core'"

  // A binding merged into a neighbouring import — what any formatter produces —
  // must read as present, or a re-run appends a second one and the app stops
  // compiling on a duplicate binding.
  it('treats a binding merged into another import from the same module as present', () => {
    const merged = "import { Router, registerAttachmentRoutes, requireAuthenticated } from '@guren/core'\n"
    expect(insertImport(merged, STATEMENT)).toBeNull()
  })

  it('sees through a multi-line import block', () => {
    const multiline = "import {\n  Router,\n  registerAttachmentRoutes,\n} from '@guren/core'\n"
    expect(insertImport(multiline, STATEMENT)).toBeNull()
  })

  // Conservative on purpose: each of these leaves the local name unbound, so
  // inserting is correct and skipping would drop a needed import.
  it('still inserts when the binding is absent, aliased away, or from another module', () => {
    expect(insertImport("import { Router } from '@guren/core'\n", STATEMENT)).not.toBeNull()
    expect(insertImport("import { registerAttachmentRoutes as mount } from '@guren/core'\n", STATEMENT)).not.toBeNull()
    expect(insertImport("import { registerAttachmentRoutes } from './local'\n", STATEMENT)).not.toBeNull()
  })

  // Each of these binds no usable value, so reading it as "already imported"
  // makes a scaffolder omit an import its generated code calls. The type and
  // alias cases are ones only the AST distinguishes.
  it('does not mistake a lookalike or a non-value import for the binding', () => {
    const cases = [
      `// ${STATEMENT}\nimport { Router } from '@guren/core'\n`,
      `const example = \`${STATEMENT}\`\n`,
      "import type { registerAttachmentRoutes } from '@guren/core'\n",
      "import { type registerAttachmentRoutes } from '@guren/core'\n",
      // Binds the wanted name to a different symbol entirely.
      "import { Router as registerAttachmentRoutes } from '@guren/core'\n",
    ]
    for (const content of cases) {
      expect(insertImport(content, STATEMENT)).not.toBeNull()
    }
  })

  it('sees a binding through a comment between the braces', () => {
    const commented = "import {\n  Router,\n  /* delivery helper */ registerAttachmentRoutes,\n} from '@guren/core'\n"
    expect(insertImport(commented, STATEMENT)).toBeNull()
  })
})

describe('insertProvider', () => {
  // The array a scaffolded worker app actually has: several lines, and a
  // plugin argument whose string literal is unrelated to the registration.
  const MULTILINE_APP = `const app = createApp({
  routes: registerWebRoutes,
  providers: [
    DatabaseProvider,
    AuthProvider,
    cloudflarePlugin(),
    mcpPlugin({ path: '/mcp' }),
  ],
})
`

  it('appends without rewriting an unrelated string literal', () => {
    const result = insertProvider(MULTILINE_APP, 'SessionProvider')

    expect(result.content).toBeDefined()
    expect(result.content).toContain('SessionProvider')
    // The defect wrote the mask back, leaving `path: '    '` — a four-space
    // route that boots, typechecks and passes `guren check`.
    expect(result.content).toContain("mcpPlugin({ path: '/mcp' })")
  })

  it('leaves the array spanning the lines it already spanned', () => {
    const result = insertProvider(MULTILINE_APP, 'SessionProvider')

    // Asserted separately from the literal: re-joining entries collapses the
    // array and blanks the literal, and either alone can regress.
    expect(result.content).toContain('\n    DatabaseProvider,\n')
    expect(result.content).toContain('  ],\n')
  })

  it('keeps a single-line array on one line', () => {
    const result = insertProvider('createApp({ providers: [DatabaseProvider] })', 'AuthProvider')

    expect(result.content).toBe('createApp({ providers: [DatabaseProvider, AuthProvider] })')
  })

  it('spans an array holding a nested one', () => {
    const nested = "createApp({ providers: [plugin({ hosts: ['a'] })] })"

    const result = insertProvider(nested, 'SessionProvider')

    // Matching to the first `]` ended the array inside `hosts`, splicing the
    // new entry into the middle of the plugin's own argument.
    expect(result.content).toBe("createApp({ providers: [plugin({ hosts: ['a'] }), SessionProvider] })")
  })

  it('does not treat a `$` in an existing entry as a replacement pattern', () => {
    const result = insertProvider('createApp({ providers: [$1, $$legacy] })', 'SessionProvider')

    expect(result.content).toBe('createApp({ providers: [$1, $$legacy, SessionProvider] })')
  })

  it('ignores a providers array that exists only in a comment', () => {
    const commented = `// providers: [OldProvider],
createApp({ providers: [DatabaseProvider] })`

    const result = insertProvider(commented, 'SessionProvider')

    expect(result.content).toContain('// providers: [OldProvider],')
    expect(result.content).toContain('providers: [DatabaseProvider, SessionProvider]')
  })

  it('reports an app with no providers array rather than inventing one', () => {
    const result = insertProvider('createApp({ routes: registerWebRoutes })', 'SessionProvider')

    expect(result.content).toBeUndefined()
    expect(result.reason).toBe(PATCH_REASONS.providersArrayNotFound)
  })
})

// The shared fixture plus the second table these cases need in the aggregate.
const PG_TABLES = `${PG_SCHEMA_FIXTURE}
export const posts = pgTable('posts', {
  id: serial('id').primaryKey(),
  title: text('title').notNull(),
})
`

const SESSIONS_BLOCK = `export const sessions = pgTable('sessions', {
  id: text('id').primaryKey(),
})
`

const everyDialect = <T,>(value: T): Record<'pg' | 'sqlite' | 'mysql', T> => ({ pg: value, sqlite: value, mysql: value })
const KEEP_IMPORTS = everyDialect((content: string) => content)

describe('appendSchemaTable', () => {

  async function appendSessions(schemaSource: string): Promise<string> {
    const workspace = await createTempWorkspace('guren-cli-append-schema-')
    try {
      await writeWorkspaceFiles(workspace.dir, { 'db/schema.ts': schemaSource })

      const result = await appendSchemaTable({
        name: 'sessions',
        blocks: everyDialect(SESSIONS_BLOCK),
        imports: KEEP_IMPORTS,
        manualGuidance: 'add it by hand.',
      })
      expect(result).toBe('appended')

      return await readFile(join(workspace.dir, 'db/schema.ts'), 'utf8')
    } finally {
      await workspace.cleanup()
    }
  }

  it('adds the identifier to a multi-line aggregate object', async () => {
    const content = await appendSessions(`${PG_TABLES}
export const schema = {
  posts,
  users,
}

export type AppSchema = typeof schema
`)

    expect(content).toContain('  users,\n  sessions,\n}')
    // The declaration must precede the aggregate that names it: a `const`
    // referencing a table declared further down is TS2448, not a style nit.
    expect(content.indexOf('export const sessions =')).toBeLessThan(content.indexOf('export const schema ='))
    expect(content).toContain('export type AppSchema = typeof schema')
  })

  it('adds the identifier to a single-line aggregate object', async () => {
    const content = await appendSessions(`${PG_TABLES}
export const schema = { users, posts }
`)

    expect(content).toContain('export const schema = { users, posts, sessions }')
    expect(content.indexOf('export const sessions =')).toBeLessThan(content.indexOf('export const schema ='))
  })

  it('does not splice into the previous statement when it carries a trailing comment', async () => {
    // Babel hands that comment to the aggregate as a leading one, and its start is
    // a column mid-line, where a splice would emit two statements on one line.
    const content = await appendSessions(`import { pgTable, serial, text } from '@guren/orm/drizzle/pg'

export const users = pgTable('users', { id: serial('id') }) // the users table
export const schema = { users }
`)

    expect(content).toContain("export const users = pgTable('users', { id: serial('id') }) // the users table")
    expect(content).toContain('export const schema = { users, sessions }')
    expect(parseSourceFile(content, 'db/schema.ts')).not.toBeNull()
  })

  it('keeps a trailing comment with the entry it was written against', async () => {
    const content = await appendSessions(`${PG_TABLES}
export const schema = {
  posts,
  users, // every table the app owns
}
`)

    expect(content).toContain('  users, // every table the app owns\n  sessions,\n}')
    expect(parseSourceFile(content, 'db/schema.ts')).not.toBeNull()
  })

  it('appends at end of file when the schema keeps no aggregate', async () => {
    const content = await appendSessions(PG_TABLES)

    expect(content).toBe(`${PG_TABLES}\n${SESSIONS_BLOCK}`)
  })

  it('leaves an object that is not a table aggregate alone', async () => {
    const content = await appendSessions(`${PG_TABLES}
const retries = 3
const timeout = 1000

export const options = { retries, timeout }
`)

    expect(content).not.toContain('sessions }')
    expect(content).toContain('export const options = { retries, timeout }')
    expect(content.trimEnd().endsWith(SESSIONS_BLOCK.trimEnd())).toBe(true)
  })

  it('leaves an aggregate ambiguous between two candidates alone', async () => {
    const content = await appendSessions(`${PG_TABLES}
export const schema = { users, posts }
export const auditable = { users }
`)

    expect(content).toContain('export const schema = { users, posts }\n')
    expect(content).toContain('export const auditable = { users }')
    expect(content.trimEnd().endsWith(SESSIONS_BLOCK.trimEnd())).toBe(true)
  })

  it('does not duplicate a key an aggregate already lists', async () => {
    const content = await appendSessions(`${PG_TABLES}
export const schema = { users, posts, sessions }
`)

    expect(content).toContain('export const schema = { users, posts, sessions }')
    expect(content).not.toContain('sessions, sessions')
    expect(content.indexOf('export const sessions =')).toBeLessThan(content.indexOf('export const schema ='))
  })
})

describe('appendSchemaTable on a schema that already declares the table', () => {
  const DECLARED = `export const sessions = pgTable('sessions', {
  id: text('id').primaryKey(),
})
`

  async function warningsFor(schemaSource: string): Promise<string> {
    const workspace = await createTempWorkspace('guren-cli-stale-aggregate-')
    try {
      await writeWorkspaceFiles(workspace.dir, { 'db/schema.ts': schemaSource })

      const { result, warnings } = await captureWarnings(() => appendSchemaTable({
        name: 'sessions',
        blocks: everyDialect(SESSIONS_BLOCK),
        imports: KEEP_IMPORTS,
        manualGuidance: 'add it by hand.',
      }))
      expect(result).toBe('already-declared')

      return warnings.join('\n')
    } finally {
      await workspace.cleanup()
    }
  }

  it('asks for the declaration to move when it sits below the aggregate', async () => {
    // The shape `guren add session` leaves behind when it appends at end of file:
    // adding the key alone would reference a binding declared further down (TS2448).
    const warned = await warningsFor(`${PG_TABLES}
export const schema = { users }

${DECLARED}`)

    expect(warned).toContain('does not list sessions')
    expect(warned).toContain('moving `export const sessions` above the object')
  })

  it('asks only for the key when the declaration already precedes the aggregate', async () => {
    const warned = await warningsFor(`${PG_TABLES}
${DECLARED}
export const schema = { users }
`)

    expect(warned).toContain('stays out of `typeof schema`')
    expect(warned).not.toContain('moving `export const sessions`')
  })
})
