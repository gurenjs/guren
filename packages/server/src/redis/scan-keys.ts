import type { Redis } from 'ioredis'

/** Cursor-based SCAN rather than the O(N), server-blocking KEYS. */
export async function scanKeys(redis: Redis, pattern: string): Promise<string[]> {
  const keys: string[] = []
  let cursor = '0'

  do {
    const [newCursor, foundKeys] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100)
    cursor = newCursor
    keys.push(...foundKeys)
  } while (cursor !== '0')

  return keys
}
