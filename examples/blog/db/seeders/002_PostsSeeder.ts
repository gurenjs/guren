import type { SeederContext } from '@guren/orm'
import { posts, schema } from '../../db/schema.js'

export default async function seed({ db }: SeederContext<typeof schema>): Promise<void> {
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
}
