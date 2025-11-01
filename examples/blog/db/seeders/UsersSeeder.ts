import { defineSeeder } from '@guren/orm'
import { ScryptHasher } from '@guren/core'
import { users } from '../schema'

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
      },
    ])
    .onConflictDoNothing({ target: users.email })
})
