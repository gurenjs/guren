import type { SeederContext } from '@guren/orm'
import { sql } from '@guren/orm/drizzle/pg'
import { posts } from '../../db/schema.js'

export default async function seed({ db }: SeederContext): Promise<void> {
  await db
    .insert(posts)
    .values([
      {
        id: 1,
        title: 'Introducing Guren',
        excerpt: 'A Laravel-inspired TypeScript framework powered by Bun.',
        body: 'Guren pairs Bun, Hono, Inertia, and Drizzle into a cohesive developer experience.',
        authorId: 1,
      },
      {
        id: 2,
        title: 'Why Inertia?',
        excerpt: 'Build modern SPAs without leaving your server-side comfort zone.',
        body: 'Inertia keeps routing on the server while letting you author rich React pages.',
        authorId: 1,
      },
    ])
    .onConflictDoNothing({ target: posts.id })

  // The rows above carry explicit ids, which never advance the serial
  // sequence — without this, the first `Post.create()` is handed id 1 and
  // dies on posts_pkey (CI only stayed green because Playwright retries).
  await db.execute(
    sql`SELECT setval(pg_get_serial_sequence('posts', 'id'), (SELECT COALESCE(MAX(id), 1) FROM posts))`,
  )
}
