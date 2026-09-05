import { defineAgentsConfig } from '../../../../src/index'

import { agentRouting } from './routing-switch'

export default defineAgentsConfig({
  agents: {
    triager: {
      module: 'app/Agents/TestAgent.ts',
      export: 'TestAgent',
      // Read only, so the write tool is a scope denial rather than a missing route.
      scopes: ['tool:posts.index'],
    },
  },
  // A getter, not a value: the generated worker reads `routing` per request, so
  // one deploy can serve both the unconfigured deny-all and a configured
  // authorizer as the suite moves the switch.
  get routing() {
    return agentRouting()
  },
})
