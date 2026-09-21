// State changes run in Redis, so a disconnected client cannot strand a job
// between pending, reserved and failed. Reservation tokens fence late workers.
// Keys built from ARGV (a queue's sets, the job hash prefix) are undeclared, which
// Redis Cluster allows only when the prefix carries one hash tag.

/** ARGV[1] = job id, ARGV[2] = reservation token ('' skips the ownership check). */
const OWNER = `
if redis.call('EXISTS', KEYS[1]) == 0 then return 0 end
if ARGV[2] ~= '' and redis.call('HGET', KEYS[1], 'reservationToken') ~= ARGV[2] then return 0 end
`

export const QUEUE_SCRIPTS = {
  /** KEYS: job, pending. ARGV: id, availableAt, ...hash fields. */
  gurenQueuePush: { numberOfKeys: 2, lua: `
redis.call('HSET', KEYS[1], unpack(ARGV, 3))
redis.call('ZADD', KEYS[2], ARGV[2], ARGV[1])
return 1
` },
  /** KEYS: pending, reserved. ARGV: now, expiresAt, reservedAt, token, job key prefix. */
  gurenQueuePop: { numberOfKeys: 2, lua: `
local expired = redis.call('ZRANGEBYSCORE', KEYS[2], '-inf', ARGV[1], 'LIMIT', 0, 100)
for _, id in ipairs(expired) do
  redis.call('ZREM', KEYS[2], id)
  local key = ARGV[5] .. id
  if redis.call('HEXISTS', key, 'id') == 1 then
    redis.call('ZADD', KEYS[1], ARGV[1], id)
    redis.call('HDEL', key, 'reservedAt', 'reservationToken')
  end
end
while true do
  local ids = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', ARGV[1], 'LIMIT', 0, 1)
  if #ids == 0 then return {} end
  local id = ids[1]
  local key = ARGV[5] .. id
  redis.call('ZREM', KEYS[1], id)
  if redis.call('HEXISTS', key, 'id') == 1 then
    redis.call('ZADD', KEYS[2], ARGV[2], id)
    redis.call('HSET', key, 'reservedAt', ARGV[3], 'reservationToken', ARGV[4])
    return redis.call('HGETALL', key)
  end
end
` },
  /** KEYS: job, pending, reserved. ARGV: id, token, attempts, availableAt ISO, lastError, availableAt ms. */
  gurenQueueRelease: { numberOfKeys: 3, lua: OWNER + `
redis.call('HSET', KEYS[1], 'attempts', ARGV[3], 'availableAt', ARGV[4])
if ARGV[5] ~= '' then redis.call('HSET', KEYS[1], 'lastError', ARGV[5]) else redis.call('HDEL', KEYS[1], 'lastError') end
redis.call('HDEL', KEYS[1], 'reservedAt', 'reservationToken')
redis.call('ZREM', KEYS[3], ARGV[1])
redis.call('ZADD', KEYS[2], ARGV[6], ARGV[1])
return 1
` },
  /** KEYS: job. ARGV: id, token, queue key prefix. */
  gurenQueueDelete: { numberOfKeys: 1, lua: OWNER + `
local queue = redis.call('HGET', KEYS[1], 'queue')
redis.call('ZREM', ARGV[3] .. queue .. ':pending', ARGV[1])
redis.call('ZREM', ARGV[3] .. queue .. ':reserved', ARGV[1])
redis.call('DEL', KEYS[1])
return 1
` },
  /** KEYS: job, pending, reserved, failed. ARGV: id, token, failedAt, error, stack, attempts. */
  gurenQueueFail: { numberOfKeys: 4, lua: OWNER + `
redis.call('HSET', KEYS[1], 'failedAt', ARGV[3], 'error', ARGV[4], 'stack', ARGV[5], 'attempts', ARGV[6])
redis.call('HDEL', KEYS[1], 'reservedAt', 'reservationToken')
redis.call('ZREM', KEYS[2], ARGV[1])
redis.call('ZREM', KEYS[3], ARGV[1])
redis.call('LREM', KEYS[4], 0, ARGV[1])
redis.call('LPUSH', KEYS[4], ARGV[1])
return 1
` },
  /** KEYS: job, reserved. ARGV: id, token, expiresAt. */
  gurenQueueExtend: { numberOfKeys: 2, lua: OWNER + `
if not redis.call('ZSCORE', KEYS[2], ARGV[1]) then return 0 end
redis.call('ZADD', KEYS[2], ARGV[3], ARGV[1])
return 1
` },
  /** KEYS: job. ARGV: id, now ISO, now ms, queue key prefix. */
  gurenQueueRetry: { numberOfKeys: 1, lua: `
local queue = redis.call('HGET', KEYS[1], 'queue')
if not queue or redis.call('HEXISTS', KEYS[1], 'failedAt') == 0 then return 0 end
redis.call('LREM', ARGV[4] .. queue .. ':failed', 0, ARGV[1])
redis.call('HSET', KEYS[1], 'attempts', '0', 'availableAt', ARGV[2], 'createdAt', ARGV[2])
redis.call('HDEL', KEYS[1], 'reservedAt', 'reservationToken', 'failedAt', 'error', 'stack', 'lastError')
redis.call('ZADD', ARGV[4] .. queue .. ':pending', ARGV[3], ARGV[1])
return 1
` },
  /** KEYS: job. ARGV: id, queue key prefix. */
  gurenQueueDeleteFailed: { numberOfKeys: 1, lua: `
local queue = redis.call('HGET', KEYS[1], 'queue')
if not queue or redis.call('HEXISTS', KEYS[1], 'failedAt') == 0 then return 0 end
redis.call('LREM', ARGV[2] .. queue .. ':failed', 0, ARGV[1])
redis.call('DEL', KEYS[1])
return 1
` },
} as const

export type QueueScriptName = keyof typeof QUEUE_SCRIPTS
