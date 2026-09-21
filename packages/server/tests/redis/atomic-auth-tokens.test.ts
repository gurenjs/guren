import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import Redis from 'ioredis'
import { randomUUID } from 'node:crypto'
import { RedisPasswordResetStore } from '../../src/redis/RedisPasswordResetStore'
import { RedisEmailVerificationStore } from '../../src/redis/RedisEmailVerificationStore'
import { createPasswordResetToken, verifyPasswordResetToken, completePasswordReset } from '../../src/auth/password-reset'
import { createEmailVerificationToken, verifyEmailToken, completeEmailVerification } from '../../src/auth/email-verification'

const describeRedis = process.env.REDIS_URL ? describe : describe.skip

describeRedis('atomic authentication tokens across Redis clients', () => {
  let clients: Redis[]
  const prefixes: string[] = []
  beforeAll(() => {
    clients = [new Redis(process.env.REDIS_URL!), new Redis(process.env.REDIS_URL!)]
    process.env.APP_KEY = 'base64:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='
    delete process.env.APP_PREVIOUS_KEYS
  })
  afterAll(async () => {
    for (const prefix of prefixes) await new RedisPasswordResetStore(clients[0], { prefix }).clear()
    await Promise.all(clients.map(client => client.quit()))
  })

  for (const kind of ['password', 'email']) {
    test(`${kind}: concurrent issuance and consumption are atomic across clients`, async () => {
      const prefix = `test:atomic-auth:${randomUUID()}:`
      prefixes.push(prefix)
      const email = 'person@example.test'
      const flows = clients.map(client => {
        const reset = new RedisPasswordResetStore(client, { prefix })
        const verification = new RedisEmailVerificationStore(client, { prefix })
        return kind === 'password' ? {
          issue: () => createPasswordResetToken('Person@Example.Test', reset),
          verify: (token: string) => verifyPasswordResetToken(token, reset),
          complete: (token: string, callback: () => Promise<void>) => completePasswordReset(
            token, 'synthetic password', reset,
            { async retrieveByCredentials() { return { email } } }, callback,
          ),
        } : {
          issue: () => createEmailVerificationToken('Person@Example.Test', verification),
          verify: (token: string) => verifyEmailToken(token, verification),
          complete: (token: string, callback: () => Promise<void>) => completeEmailVerification(
            token, verification, async () => { await callback(); return { email } },
          ),
        }
      })
      const tokens = await Promise.all(Array.from({ length: 20 }, (_, i) => flows[i % 2].issue()))
      const valid = await Promise.all(tokens.map(({ token }) => flows[0].verify(token)))
      expect(valid.filter(Boolean)).toEqual([email])
      const token = tokens[valid.findIndex(Boolean)].token
      let calls = 0
      const results = await Promise.all(Array.from({ length: 20 }, (_, i) => flows[i % 2].complete(token, async () => { calls++ })))
      expect(calls).toBe(1)
      expect(results.filter(Boolean)).toHaveLength(1)
      expect(await flows[0].verify(token)).toBeNull()
      expect(await clients[0].smembers(`${prefix}email:${email}`)).toEqual([])
    })

    test(`${kind}: consumption compares the authenticated email and preserves a newer issuance`, async () => {
      const prefix = `test:atomic-auth:${randomUUID()}:`
      prefixes.push(prefix)
      const expiresAt = new Date(Date.now() + 60_000)
      const store = kind === 'password'
        ? new RedisPasswordResetStore(clients[0], { prefix })
        : new RedisEmailVerificationStore(clients[0], { prefix })
      const replace = async (tokenId: string) => {
        if (store instanceof RedisPasswordResetStore) await store.replace(tokenId, 'person@example.test', expiresAt)
        else await store.replace({ tokenId, email: 'person@example.test', expiresAt, createdAt: new Date() })
      }
      await replace('old')
      expect(await store.consume('old', 'wrong@example.test')).toBe(false)
      await replace('new')
      expect(await store.consume('old', 'person@example.test')).toBe(false)
      expect(await store.consume('new', 'person@example.test')).toBe(true)
    })
  }
})
