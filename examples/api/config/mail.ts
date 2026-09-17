import { defineMailConfig } from '@guren/core'

export default defineMailConfig(() => ({
  default: 'memory',
  from: { email: 'noreply@api.example.com', name: 'Guren API' },
  transports: {
    memory: { driver: 'memory' },
  },
}))
