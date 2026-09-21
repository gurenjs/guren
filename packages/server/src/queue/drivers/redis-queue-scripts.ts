// State changes run in Redis, so a disconnected client cannot strand a job
// between pending, reserved and failed. Reservation tokens fence late workers.
export const PUSH = `
redis.call('HSET', KEYS[1], unpack(ARGV, 3))
redis.call('ZADD', KEYS[2], ARGV[2], ARGV[1])
return 1
`

export const POP = `
local expired = redis.call('ZRANGEBYSCORE', KEYS[2], '-inf', ARGV[1])
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
`

const OWNER = `
if redis.call('EXISTS', KEYS[1]) == 0 then return 0 end
if ARGV[2] ~= '' and redis.call('HGET', KEYS[1], 'reservationToken') ~= ARGV[2] then return 0 end
`

export const RELEASE = OWNER + `
redis.call('HSET', KEYS[1], 'attempts', ARGV[3], 'availableAt', ARGV[4], 'lastError', ARGV[5])
redis.call('HDEL', KEYS[1], 'reservedAt', 'reservationToken')
redis.call('ZREM', KEYS[3], ARGV[1])
redis.call('ZADD', KEYS[2], ARGV[6], ARGV[1])
return 1
`

export const DELETE = OWNER + `
redis.call('ZREM', KEYS[2], ARGV[1])
redis.call('ZREM', KEYS[3], ARGV[1])
redis.call('DEL', KEYS[1])
return 1
`

export const FAIL = OWNER + `
redis.call('HSET', KEYS[1], 'failedAt', ARGV[3], 'error', ARGV[4], 'stack', ARGV[5], 'attempts', ARGV[6])
redis.call('HDEL', KEYS[1], 'reservedAt', 'reservationToken')
redis.call('ZREM', KEYS[2], ARGV[1])
redis.call('ZREM', KEYS[3], ARGV[1])
redis.call('LREM', KEYS[4], 0, ARGV[1])
redis.call('LPUSH', KEYS[4], ARGV[1])
return 1
`

export const EXTEND = OWNER + `
if not redis.call('ZSCORE', KEYS[2], ARGV[1]) then return 0 end
redis.call('ZADD', KEYS[2], ARGV[3], ARGV[1])
return 1
`

export const RETRY = `
if redis.call('HEXISTS', KEYS[1], 'failedAt') == 0 then return 0 end
redis.call('LREM', KEYS[3], 0, ARGV[1])
redis.call('HSET', KEYS[1], 'attempts', '0', 'availableAt', ARGV[2], 'createdAt', ARGV[2])
redis.call('HDEL', KEYS[1], 'reservedAt', 'reservationToken', 'failedAt', 'error', 'stack', 'lastError')
redis.call('ZADD', KEYS[2], ARGV[3], ARGV[1])
return 1
`

export const DELETE_FAILED = `
if redis.call('HEXISTS', KEYS[1], 'failedAt') == 0 then return 0 end
redis.call('LREM', KEYS[2], 0, ARGV[1])
redis.call('DEL', KEYS[1])
return 1
`
