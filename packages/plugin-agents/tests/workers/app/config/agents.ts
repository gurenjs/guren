import { defineAgentsConfig } from '../../../../src/index'

import { approvalQueue } from './approval-queue'
import { agentRouting } from './routing-switch'

export default defineAgentsConfig({
  agents: {
    triager: {
      module: 'app/Agents/TestAgent.ts',
      export: 'TestAgent',
      // `posts.store` is left out, so the write tool is a scope denial rather
      // than a missing route; `posts.destroy` is in, and gated on approval.
      scopes: ['tool:posts.index', 'tool:posts.destroy'],
    },
    thrifty: {
      module: 'app/Agents/ThriftyAgent.ts',
      export: 'ThriftyAgent',
      scopes: ['tool:posts.destroy'],
      // Two calls buys a park and a status check; the retry is the third, so
      // the rate-limited-retry path is reachable without waiting out a window.
      budget: { callsPerMinute: 2 },
    },
  },
  approvals: { store: approvalQueue, notify: () => {} },
  // A getter, not a value: the generated worker reads `routing` per request, so
  // one deploy can serve both the unconfigured deny-all and a configured
  // authorizer as the suite moves the switch.
  get routing() {
    return agentRouting()
  },
})
