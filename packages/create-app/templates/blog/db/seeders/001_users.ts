import { defineSeeder, ScryptHasher } from '@guren/core'
import { eq } from 'drizzle-orm'
import { users } from '../schema.js'

export const DEMO_EMAIL = 'demo@example.com'

// Existence is checked rather than upserted because the three databases this
// template supports spell conflict handling differently.
export default defineSeeder(async ({ db }) => {
  const existing = await db.select().from(users).where(eq(users.email, DEMO_EMAIL)).limit(1)
  if (existing.length > 0) {
    return
  }

  const hasher = new ScryptHasher()

  await db.insert(users).values({
    name: '__APP_TITLE__ Demo',
    email: DEMO_EMAIL,
    passwordHash: await hasher.hash('secret'),
  })
})
