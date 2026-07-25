import { defineSeeder } from '@guren/orm'
import { ScryptHasher } from '@guren/core'
import { users } from '../schema.js'

export default defineSeeder(async ({ db }) => {
  const hasher = new ScryptHasher()
  const passwordHash = await hasher.hash('secret')

  await db
    .insert(users)
    .values([
      {
        name: 'Demo User',
        email: 'demo@guren.dev',
        passwordHash,
        // Pre-verified so the seeded demo account can reach /dashboard
        // immediately — matches the account's role as a login E2E fixture.
        emailVerifiedAt: new Date(),
      },
    ])
    .onConflictDoNothing({ target: users.email })
})
