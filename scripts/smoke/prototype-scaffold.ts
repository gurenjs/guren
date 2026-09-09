/**
 * The prototype-first loop on a fresh default app (RFC 0021 Part 3), run by
 * the fresh-app smoke: `add prototype`, `make:feature --prototype`, the routes
 * on the `prototype` handler, `check --prototype`, a static `build:prototype`
 * with no database, then promotion — the sqlite table, `make:feature` without
 * the flag, the handler swap — leaving an ordinary app for the smoke's own
 * typecheck, build and gate. Judged by exit codes and the files left behind.
 */
import { existsSync } from 'node:fs'
import { readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { buildRouteRegistrationHint } from '../../packages/cli/src/make-feature'
import { ensureSqliteImports } from '../../packages/cli/src/patch-helpers'

export interface PrototypeScaffoldOptions {
  appDir: string
  cliBin: string
  env: Record<string, string>
  run: (cmd: string[], cwd: string, env?: Record<string, string>) => Promise<void>
}

const FIELDS = 'title:string,body:text?,done:boolean'
/** A string only the generated seed contains, so the static bundle can be told from the production one. */
const SEED_MARKER = 'Sample title 1'

const NOTES_TABLE = `
export const notes = sqliteTable('notes', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  title: text('title').notNull(),
  body: text('body'),
  done: integer('done', { mode: 'boolean' }).notNull().default(false),
})
`

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`[smoke:prototype-scaffold] ${message}`)
}

function routeBlock(handler: 'prototype' | 'controller'): string {
  return buildRouteRegistrationHint({ singular: 'Note', routeName: 'notes', routeVar: 'notes', withAuth: true, handler })
    .map((line) => `  ${line}`)
    .join('\n')
}

/** Appends `block` inside the registrar, before the file's last closing brace, plus the imports it needs. */
async function appendRoutes(appDir: string, imports: string[], block: string): Promise<void> {
  const path = join(appDir, 'routes/web.ts')
  let content = await readFile(path, 'utf8')
  const close = content.lastIndexOf('}')
  assert(close !== -1, 'routes/web.ts has no closing brace to append before')
  content = `${content.slice(0, close)}\n${block}\n${content.slice(close)}`
  content = `${imports.join('\n')}\n${content}`
  await writeFile(path, content, 'utf8')
}

async function filesUnder(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true })
  return entries.filter((entry) => entry.isFile()).map((entry) => join(entry.parentPath ?? entry.path, entry.name))
}

export async function runPrototypeScaffold(options: PrototypeScaffoldOptions): Promise<void> {
  const { appDir, cliBin, env, run } = options
  const cli = (...args: string[]) => run(['bun', cliBin, ...args], appDir, env)

  await cli('add', 'prototype')
  for (const file of ['resources/js/prototype/index.ts']) {
    assert(existsSync(join(appDir, file)), `add prototype did not write ${file}`)
  }
  const clientEntry = await readFile(join(appDir, 'resources/js/app.tsx'), 'utf8')
  assert(clientEntry.includes('prototype: import.meta.env.GUREN_PROTOTYPE'), 'add prototype did not wire startInertiaClient()')
  const appEntry = await readFile(join(appDir, 'src/app.ts'), 'utf8')
  assert(appEntry.includes("prototype: () => import('../resources/js/prototype/index.js')"), 'add prototype did not wire createApp()')

  await cli('make:feature', 'Note', '--fields', FIELDS, '--prototype')
  for (const absent of ['app/Http/Controllers/NoteController.ts', 'app/Models/Note.ts', 'app/Http/Resources/NoteResource.ts']) {
    assert(!existsSync(join(appDir, absent)), `make:feature --prototype wrote ${absent}, which is backend`)
  }
  assert(existsSync(join(appDir, 'resources/js/types/Note.ts')), 'make:feature --prototype did not write the page-data type')
  const fixture = await readFile(join(appDir, 'resources/js/prototype/index.ts'), 'utf8')
  assert(fixture.includes("'notes.index':") && fixture.includes(SEED_MARKER), 'make:feature --prototype did not append the fixture entries')

  await appendRoutes(
    appDir,
    ["import { prototype, requireAuthenticated } from '@guren/core'", "import { NotePayloadSchema } from '../app/Http/Validators/NoteValidator.js'"],
    routeBlock('prototype'),
  )
  await cli('codegen', '--force')
  // The gate for the customer-facing build: exits non-zero on a wiring failure.
  await cli('check', '--prototype')
  await run(['bun', 'run', 'typecheck'], appDir, env)

  // No database is configured or migrated at this point: the static build must not need one.
  await run(['bunx', 'vite', 'build', '--mode', 'prototype'], appDir, env)
  const outDir = join(appDir, 'dist/prototype')
  for (const file of ['index.html', '404.html', '_redirects']) {
    assert(existsSync(join(outDir, file)), `build:prototype did not emit ${file}`)
  }
  const chunks = await filesUnder(outDir)
  const seeded = await Promise.all(chunks.filter((file) => file.endsWith('.js')).map(async (file) => (await readFile(file, 'utf8')).includes(SEED_MARKER)))
  assert(seeded.some(Boolean), 'the prototype bundle carries no fixture seed')
  console.log('\n[smoke:prototype-scaffold] prototype-first: static build ok, no backend')

  // Promotion: the table the model needs, the backend files, the handler swap.
  const schemaPath = join(appDir, 'db/schema.ts')
  const schema = await readFile(schemaPath, 'utf8')
  await writeFile(schemaPath, `${ensureSqliteImports(schema, ['sqliteTable', 'integer', 'text'])}${NOTES_TABLE}`, 'utf8')
  await cli('make:feature', 'Note', '--fields', FIELDS)
  for (const present of ['app/Http/Controllers/NoteController.ts', 'app/Models/Note.ts', 'app/Http/Resources/NoteResource.ts']) {
    assert(existsSync(join(appDir, present)), `promotion did not write ${present}`)
  }
  const resource = await readFile(join(appDir, 'app/Http/Resources/NoteResource.ts'), 'utf8')
  assert(resource.includes("import type { NoteData } from '@/resources/js/types/Note'"), 'promotion did not type the Resource against the page-data type')

  const routesPath = join(appDir, 'routes/web.ts')
  const routes = await readFile(routesPath, 'utf8')
  assert(routes.includes(routeBlock('prototype')), 'the prototype route block was not found verbatim for the handler swap')
  await writeFile(
    routesPath,
    `import NoteController from '../app/Http/Controllers/NoteController.js'\n${routes.replace(routeBlock('prototype'), routeBlock('controller'))}`,
    'utf8',
  )
  const promotedFixture = await readFile(join(appDir, 'resources/js/prototype/index.ts'), 'utf8')
  assert(promotedFixture === fixture, 'promotion must leave the fixture as it was')
  console.log('[smoke:prototype-scaffold] promoted: backend written, pages and fixture kept')
}
