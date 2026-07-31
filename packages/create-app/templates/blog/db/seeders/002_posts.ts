import { defineSeeder } from '@guren/core'
import { eq } from 'drizzle-orm'
import type { AppSeederContext } from '../../config/database.js'
import { posts, users } from '../schema.js'
import { DEMO_EMAIL } from './001_users.js'

const SAMPLE_POSTS = [
  {
    title: 'Hello from Guren',
    excerpt: 'The first post on this blog, written by the seeder.',
    body: 'Every page you see here is server-rendered by a controller and hydrated by Inertia. Edit resources/js/pages/posts/Show.tsx to change this layout.',
  },
  {
    title: 'Writing your second post',
    excerpt: 'Sign in as the demo user and publish from the browser.',
    body: 'Sign in with demo@example.com / secret, then open /posts/create. Posts belong to their author, and PostPolicy stops anyone else editing them.',
  },
]

export default defineSeeder(async ({ db }: AppSeederContext) => {
  const [author] = await db.select().from(users).where(eq(users.email, DEMO_EMAIL)).limit(1)
  if (!author) {
    return
  }

  const existing = await db.select().from(posts).where(eq(posts.authorId, author.id)).limit(1)
  if (existing.length > 0) {
    return
  }

  await db.insert(posts).values(SAMPLE_POSTS.map((post) => ({ ...post, authorId: author.id })))
})
