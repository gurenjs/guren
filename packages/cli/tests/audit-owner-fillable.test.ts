import { describe, expect, it } from 'bun:test'
import { runAudit, type AuditReport } from '../src/audit'
import { createTempWorkspace, writeWorkspaceFiles } from './helpers'

/** Audits the schema and User model below plus `files`; pass `withUser: false` to leave User out. */
async function audit(files: Record<string, string>, { withUser = true } = {}): Promise<AuditReport> {
  const workspace = await createTempWorkspace('guren-cli-audit-owner-fillable-')
  try {
    await writeWorkspaceFiles(workspace.dir, { 'db/schema.ts': schema, ...(withUser ? { 'app/Models/User.ts': user } : {}), ...files })
    return await runAudit({ cwd: workspace.dir })
  } finally {
    await workspace.cleanup()
  }
}

const schema = `import { integer, sqliteTable, text, foreignKey } from 'drizzle-orm/sqlite-core'
export const users = sqliteTable('users', {
  id: integer('id').primaryKey(),
  email: text('email').notNull(),
  passwordHash: text('password_hash').notNull(),
})
export const categories = sqliteTable('categories', {
  id: integer('id').primaryKey(),
})
export const posts = sqliteTable('posts', {
  id: integer('id').primaryKey(),
  title: text('title').notNull(),
  authorId: integer('author_id').notNull().references(() => users.id),
  categoryId: integer('category_id').references(() => categories.id),
})
export const notes = sqliteTable('notes', {
  id: integer('id').primaryKey(),
  ownerId: integer('owner_id').notNull(),
}, (table) => [foreignKey({ columns: [table.ownerId], foreignColumns: [users.id] })])
`

const user = `import { AuthenticatableModel, defineModel } from '@guren/core'
import { users } from '../../db/schema.js'
export class User extends defineModel(users, { base: AuthenticatableModel, fillable: ['email'] }) {}
`

const model = (name: string, table: string, fillable: string[]) => `import { defineModel } from '@guren/core'
import { ${table} } from '../../db/schema.js'
export class ${name} extends defineModel(${table}, { fillable: ${JSON.stringify(fillable)} }) {}
`

const owner = (report: AuditReport, name: string) => report.findings.find((f) => f.key === `owner-fillable:${name}`)

describe('owner column in fillable', () => {
  it('warns on a fillable column that references the users table', async () => {
    const report = await audit({
      'app/Models/Post.ts': model('Post', 'posts', ['title', 'authorId']),
    })
    const found = owner(report, 'Post')
    expect(found?.status).toBe('warn')
    expect(found?.message).toContain("'authorId'")
    expect(found?.suggestion).toContain('create(data, { set: { authorId: user.id } })')
    expect(found?.filePath).toBe('app/Models/Post.ts')
  })

  it('reads a table-level foreignKey to the users table too', async () => {
    const report = await audit({
      'app/Models/Note.ts': model('Note', 'notes', ['ownerId']),
    })
    expect(owner(report, 'Note')?.message).toContain("'ownerId'")
  })

  it('says nothing when the owner column stays out of fillable', async () => {
    const report = await audit({
      'app/Models/Post.ts': model('Post', 'posts', ['title']),
    })
    expect(owner(report, 'Post')).toBeUndefined()
  })

  it('says nothing about a fillable foreign key to another table', async () => {
    const report = await audit({
      'app/Models/Post.ts': model('Post', 'posts', ['title', 'categoryId']),
    })
    expect(owner(report, 'Post')).toBeUndefined()
  })

  it('says nothing when no model is authenticatable, so no table is the users table', async () => {
    const report = await audit({ 'app/Models/Post.ts': model('Post', 'posts', ['title', 'authorId']) }, { withUser: false })
    expect(owner(report, 'Post')).toBeUndefined()
  })
})
