/** Replace the indexed tokens and publish their successor as one Redis operation. */
export const REPLACE_AUTH_TOKEN = `
local ids = redis.call('SMEMBERS', KEYS[1])
for _, id in ipairs(ids) do
  redis.call('DEL', ARGV[1] .. id)
end
redis.call('DEL', KEYS[1])
local ttl = tonumber(ARGV[4])
if ttl > 0 then
  redis.call('PSETEX', KEYS[2], ttl, ARGV[3])
  redis.call('SADD', KEYS[1], ARGV[2])
  redis.call('PEXPIRE', KEYS[1], ttl + 60000)
end
return 1
`

/** Compare and consume without a GET/DEL race between different workers. */
export const CONSUME_AUTH_TOKEN = `
local raw = redis.call('GET', KEYS[1])
if not raw then return 0 end
local ok, record = pcall(cjson.decode, raw)
if not ok or type(record) ~= 'table' or record.email ~= ARGV[1] then return 0 end
redis.call('DEL', KEYS[1])
redis.call('SREM', KEYS[2], ARGV[2])
return 1
`
