import { defineSeeder } from '@guren/orm'
import { Hash } from '@guren/core'
import { users } from '../schema.js'

export default defineSeeder(async ({ db }) => {
  const hasher = new Hash()
  const passwordHash = await hasher.hash('secret')

  await db
    .insert(users)
    .values([
      {
        name: 'Demo User',
        email: 'demo@guren.dev',
        passwordHash,
        // Pre-verified so this login E2E fixture reaches /dashboard immediately.
        emailVerifiedAt: new Date(),
      },
    ])
    .onConflictDoNothing({ target: users.email })
})
