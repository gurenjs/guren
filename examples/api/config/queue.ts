import { defineQueueConfig, MemoryDriver } from '@guren/core'

export default defineQueueConfig(() => ({
  default: 'memory',
  drivers: {
    memory: () => new MemoryDriver(),
  },
}))
