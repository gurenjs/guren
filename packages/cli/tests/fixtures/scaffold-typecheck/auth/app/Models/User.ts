// Companion for typechecking templates/scaffold/auth: what
// buildUserModelTemplate(true) in make-auth.ts emits. Pinned to the builder
// by scaffold-output.test.ts, so a builder change fails there with
// instructions rather than silently drifting from this copy.
import { AuthenticatableModel, defineModel } from '@guren/core'
import { users } from '../../db/schema.js'

export type UserRecord = typeof users.$inferSelect

export class User extends defineModel(users, {
  base: AuthenticatableModel,
  // Derived from the plain `password`, so callers never set it directly
  optionalOnCreate: ['passwordHash'],
  requireOnCreate: ['password'],
  // Never serialized by Model.serialize() and stripped from auth.user()
  hidden: ['passwordHash', 'rememberToken'],
}) {
  // passwordHash and rememberToken are denied from mass assignment by
  // AuthenticatableModel itself — no per-model configuration needed.
}
