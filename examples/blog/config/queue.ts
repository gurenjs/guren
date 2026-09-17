import { defineQueueConfig, MemoryDriver, SyncDriver } from '@guren/core'

// QUEUE_CONNECTION=memory queues jobs for a Worker; `sync` runs them inline on dispatch.
const drivers = {
  sync: () => new SyncDriver(),
  memory: () => new MemoryDriver(),
}

export default defineQueueConfig((env) => {
  // Checked at boot: the manager accepts any name and throws on the first dispatch.
  if (!Object.hasOwn(drivers, env.QUEUE_CONNECTION)) {
    throw new Error(
      `QUEUE_CONNECTION="${env.QUEUE_CONNECTION}" is not a declared driver. Declare it in config/queue.ts or use one of: ${Object.keys(drivers).join(', ')}.`,
    )
  }

  return { default: env.QUEUE_CONNECTION, drivers }
})
