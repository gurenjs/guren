import { EncryptionServiceProvider, EventServiceProvider, createApp } from '@guren/core'
import { agentsPlugin } from '@guren/plugin-agents'

import AuthProvider from '../app/Providers/AuthProvider'
import DatabaseProvider from '../app/Providers/DatabaseProvider'
import { approvalStore } from '../app/Services/DrizzleApprovalStore'
import agents from '../config/agents'
import registerApiRoutes from '../routes/api'

const app = createApp({
  routes: registerApiRoutes,
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
        // A real deployment pages someone. The demo's operator polls
        // `GET /approvals`, so the log line is the notification.
        notify: (request) =>
          console.log(
            `[approvals] ${request.tool} awaits a human: `
            + `POST /approvals/${request.id}/approve (expires ${request.expiresAt})`,
          ),
      },
    }),
  ],
})

export default app
