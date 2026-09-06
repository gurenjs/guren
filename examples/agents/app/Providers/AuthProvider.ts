import { ServiceProvider, defineGate } from '@guren/core'
import type { AuthManager, AuthUser } from '@guren/core'

import { apiTokenStore } from '../Services/DrizzleApiTokenStore'

/**
 * The one principal shape the agent arrives as: `agent:<name>:<instance>`, with
 * the registry key from `config/agents.ts` in the middle. Anchored, because
 * `agent:triagerX:` must not match.
 */
const TRIAGER_PRINCIPAL = /^agent:triager:/u

/** An operator is a row in `users`, so its id is the integer primary key. */
function isOperator(user: AuthUser | null): boolean {
  return typeof user?.id === 'number'
}

export default class AuthProvider extends ServiceProvider {
  register(): void {
    // One auth story for both callers. The bearer header selects this guard;
    // a principal the agent pipeline installed on the request selects the
    // seam's guard ahead of it, so `requireAuthenticated()` answers for both.
    // `createBearerTokenMiddleware` would not: it judges an issued ApiToken,
    // which the seam deliberately does not synthesize (RFC 0017 §2).
    this.container.make<AuthManager>('auth').useTokens(apiTokenStore)

    // The ability `POST /tickets/:id/close` authorizes. Its existence is what
    // makes that route a legal non-read-only agent tool: `guren check` reads
    // the capability `authorizeMiddleware` stamps, and refuses a mutating tool
    // that carries only authentication.
    defineGate('close-ticket', (user) =>
      isOperator(user) || (typeof user?.id === 'string' && TRIAGER_PRINCIPAL.test(user.id)))

    // Resolving approvals and driving the agent are for people. Today only a
    // `users` row can hold a bearer token, so `requireAuthenticated()` alone
    // would pass — the ability is what keeps that true when a second role
    // that can mint tokens arrives.
    defineGate('operate', (user) => isOperator(user))
  }
}
