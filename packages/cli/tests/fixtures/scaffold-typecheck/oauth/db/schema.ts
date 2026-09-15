// Companion for typechecking templates/scaffold/oauth: the oauth_states table
// the blueprint's Postgres schema patch produces (pinned by scaffold-output.test.ts).
// OAuthProvider.ts only ever imports the `oauthStates` export.
import { index, pgTable, text, timestamp } from '@guren/orm/drizzle/pg'

export const oauthStates = pgTable('oauth_states', {
  stateHash: text('state_hash').primaryKey(),
  provider: text('provider').notNull(),
  redirectTo: text('redirect_to'),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  binding: text('binding'),
}, (t) => [index('oauth_states_expires_at_idx').on(t.expiresAt)])
