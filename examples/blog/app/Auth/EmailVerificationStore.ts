import { MemoryEmailVerificationStore } from '@guren/core'

// Swap for a Redis-backed store (@guren/core/redis) in production or any
// multi-instance deployment: this one dies with the process and is not shared.
export const emailVerificationStore = new MemoryEmailVerificationStore()
