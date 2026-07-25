import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { generateErSpec } from '../src/spec-er'
import { generateDomainSpec } from '../src/spec-domain'
import { SPEC_BANNER } from '../src/spec-generate'
import { createTempWorkspace, type TempWorkspace } from './helpers'

describe('spec views (er + domain)', () => {
  let workspace: TempWorkspace

  beforeAll(async () => {
    workspace = await createTempWorkspace('guren-cli-spec-er-domain-')
    const dir = workspace.dir

    await mkdir(join(dir, 'db'), { recursive: true })
    await mkdir(join(dir, 'app/Models'), { recursive: true })
    await mkdir(join(dir, 'modules/billing/app/Models'), { recursive: true })
    await mkdir(join(dir, 'modules/billing/db'), { recursive: true })
    await writeFile(join(dir, 'package.json'), '{}', 'utf8')

    await writeFile(
      join(dir, 'db/schema.ts'),
      `import { pgTable, serial, text, integer } from 'drizzle-orm/pg-core'

export const users = pgTable('users', {
  id: serial('id').primaryKey(),
  email: text('email').notNull(),
})

export const posts = pgTable('posts', {
  id: serial('id').primaryKey(),
  title: text('title').notNull(),
  authorId: integer('author_id').references(() => users.id),
})
`,
      'utf8',
    )
    await writeFile(
      join(dir, 'modules/billing/db/schema.ts'),
      `import { pgTable, serial } from 'drizzle-orm/pg-core'
export const invoices = pgTable('invoices', { id: serial('id') })
`,
      'utf8',
    )

    await writeFile(
      join(dir, 'app/Models/Post.ts'),
      `import { defineModel, type BelongsToRecord } from '@guren/orm'
import { posts } from '../../db/schema.js'
import type { UserRecord } from './User.js'

export class Post extends defineModel(posts) {
  static override relationTypes: { author: BelongsToRecord<UserRecord> } = {
    author: null,
  }
}
`,
      'utf8',
    )
    await writeFile(
      join(dir, 'app/Models/User.ts'),
      `import { defineModel, type HasManyRecord } from '@guren/orm'
import { users } from '../../db/schema.js'
import type { PostRecord } from './Post.js'

export class User extends defineModel(users) {
  static override relationTypes: { posts: HasManyRecord<PostRecord> } = {
    posts: [],
  }
}
`,
      'utf8',
    )
    await writeFile(
      join(dir, 'modules/billing/app/Models/Invoice.ts'),
      `import { defineModel } from '@guren/orm'
import { invoices } from '../../db/schema.js'

export class Invoice extends defineModel(invoices) {}
`,
      'utf8',
    )
  })

  afterAll(async () => {
    await workspace.cleanup()
  })

  it('renders the ER view with attributes, FK marks, and relationship edges', async () => {
    const artifact = await generateErSpec(workspace.dir)

    expect(artifact.fileName).toBe('er.md')
    expect(artifact.content.startsWith(SPEC_BANNER)).toBe(true)
    expect(artifact.content).toContain('erDiagram')
    expect(artifact.content).toContain('serial id PK')
    expect(artifact.content).toContain('integer authorId FK')
    // Edge from the model relationship (belongsTo author)
    expect(artifact.content).toContain('posts }o--|| users : author')
    // Attribute detail table carries nullability
    expect(artifact.content).toContain('| title | text | not null |')
    // Module table present and tagged
    expect(artifact.content).toContain('## invoices (module: billing)')
  })

  it('renders the domain view with namespaces and cardinality edges', async () => {
    const artifact = await generateDomainSpec(workspace.dir)

    expect(artifact.fileName).toBe('domain.md')
    expect(artifact.content).toContain('classDiagram')
    expect(artifact.content).toContain('namespace billing {')
    expect(artifact.content).toContain('class Invoice')
    expect(artifact.content).toContain('Post "*" --> "1" User : author')
    expect(artifact.content).toContain('User "1" --> "*" Post : posts')
    expect(artifact.content).toContain('- **Post** (app/Models/Post.ts) — table: `posts`')
  })

  it('is deterministic: regenerating produces byte-identical content', async () => {
    const [er1, er2] = [await generateErSpec(workspace.dir), await generateErSpec(workspace.dir)]
    const [d1, d2] = [
      await generateDomainSpec(workspace.dir),
      await generateDomainSpec(workspace.dir),
    ]

    expect(er1.content).toBe(er2.content)
    expect(d1.content).toBe(d2.content)
  })

  it('degrades gracefully on an empty app', async () => {
    const empty = await createTempWorkspace('guren-cli-spec-empty-')
    try {
      const er = await generateErSpec(empty.dir)
      const domain = await generateDomainSpec(empty.dir)

      expect(er.content).toContain('No tables found.')
      expect(domain.content).toContain('No models found.')
    } finally {
      await empty.cleanup()
    }
  })
})
