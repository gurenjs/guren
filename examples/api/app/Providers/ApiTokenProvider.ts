import { MemoryApiTokenStore } from '@guren/core'

// Shared token store (in production, use DB-backed store)
const tokenStore = new MemoryApiTokenStore()

export function getTokenStore() {
  return tokenStore
}
