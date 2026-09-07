import { DatabaseSessionStore, EncryptionServiceProvider, EventServiceProvider, createApp } from '@guren/core'
import { agentsPlugin } from '@guren/plugin-agents'

import AuthProvider from '../app/Providers/AuthProvider'
import DatabaseProvider from '../app/Providers/DatabaseProvider'
import { approvalStore } from '../app/Services/DrizzleApprovalStore'
import agents from '../config/agents'
import { sessions } from '../db/schema'
import registerWebRoutes from '../routes/web'

/**
 * A `Secure` cookie is silently dropped over the plain HTTP both local paths
 * serve, and login just never sticks. `NODE_ENV` cannot decide it on Workers:
 * wrangler.jsonc defines it to `"production"` at bundle time, local or not.
 * This app's own variable is the local-only signal; the framework reads no such
 * name. Called late, never at module scope: `vars` land after this evaluates.
 */
function secureCookies(): boolean {
  return process.env.NODE_ENV === 'production' && process.env.TRIAGER_INSECURE_COOKIES !== '1'
}

const app = createApp({
  routes: registerWebRoutes,
  providers: [
    DatabaseProvider,
    AuthProvider,
    EventServiceProvider,
    // Before `agentsPlugin`, which reads the `encrypter` binding at boot: with
    // no cipher there is no pending-approval ledger, so a parked call is
    // reported to the agent and never retried.
    EncryptionServiceProvider,
    // The store is spread in here rather than written into `config/agents.ts`,
    // which `guren cloudflare:build` reads as source for the worker's named
    // exports and `guren check` reads for the static registration grammar.
    agentsPlugin({
      ...agents,
      approvals: {
        store: approvalStore,
        // A real deployment pages someone. The demo's operator watches the
        // console, so the log line is the notification.
        notify: (request) =>
          console.log(
            `[approvals] ${request.tool} awaits a human: `
            + `POST /approvals/${request.id}/approve (expires ${request.expiresAt})`,
          ),
      },
    }),
  ],
  auth: {
    autoSession: true,
    sessionOptions: {
      // A `Map` in the isolate would not do: a Worker answers the login
      // redirect and the page it lands on from different isolates.
      store: new DatabaseSessionStore(sessions),
      // Getters, not values: the session middleware is built at boot and the
      // XSRF cookie is written per request, both late enough to read `vars`.
      get cookieSecure() {
        return secureCookies()
      },
    },
    csrfOptions: {
      cookieOptions: {
        get secure() {
          return secureCookies()
        },
      },
    },
  },
})

export default app
