import { MemoryEmailVerificationStore } from '@guren/core'

// Swap for a Redis-backed store (see @guren/core/redis) in production
// or any multi-instance deployment — this in-memory store does not
// survive restarts and is not shared across processes.
export const emailVerificationStore = new MemoryEmailVerificationStore()
