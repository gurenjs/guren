import type { Redis } from 'ioredis'

/**
 * Scan Redis keys matching a pattern without blocking the server.
 * Uses SCAN with cursor-based iteration to avoid the O(N) KEYS command.
 */
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
