import { describe, expect, test } from 'bun:test'
import {
  MemoryPasswordResetStore, createPasswordResetToken, verifyPasswordResetToken, completePasswordReset,
  type PasswordResetTokenStore,
} from '../../src/auth/password-reset'
import {
  MemoryEmailVerificationStore, createEmailVerificationToken, verifyEmailToken, completeEmailVerification,
  type EmailVerificationTokenStore,
} from '../../src/auth/email-verification'

process.env.APP_KEY = 'base64:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='
delete process.env.APP_PREVIOUS_KEYS
const email = 'person@example.test'
const provider = { async retrieveByCredentials() { return { email } } }

function flows() {
  const resetStore = new MemoryPasswordResetStore()
  const emailStore = new MemoryEmailVerificationStore()
  return [
    {
      name: 'password reset',
      create: (address = email) => createPasswordResetToken(address, resetStore),
      verify: (token: string) => verifyPasswordResetToken(token, resetStore),
      complete: (token: string, callback: () => Promise<void>) =>
        completePasswordReset(token, 'synthetic password', resetStore, provider, callback),
    },
    {
      name: 'email verification',
      create: (address = email) => createEmailVerificationToken(address, emailStore),
      verify: (token: string) => verifyEmailToken(token, emailStore),
      complete: (token: string, callback: () => Promise<void>) =>
        completeEmailVerification(token, emailStore, async () => { await callback(); return { email } }),
    },
  ]
}

for (const index of [0, 1]) {
  describe(flows()[index].name, () => {
    test('admits one completion while its callback is still pending', async () => {
      const flow = flows()[index]
      const { token } = await flow.create()
      let entered!: () => void
      let release!: () => void
      const started = new Promise<void>(resolve => { entered = resolve })
      const blocked = new Promise<void>(resolve => { release = resolve })
      let calls = 0
      const first = flow.complete(token, async () => { calls++; entered(); await blocked })
      await started
      try {
        const others = await Promise.all(Array.from({ length: 10 }, () => flow.complete(token, async () => { calls++ })))
        expect(others.every(value => value === null)).toBe(true)
        expect(calls).toBe(1)
      } finally {
        release()
        await first
      }
    })

    test('concurrent issuance leaves only one usable token for the email', async () => {
      const flow = flows()[index]
      const tokens = await Promise.all(Array.from({ length: 10 }, () => flow.create()))
      const valid = await Promise.all(tokens.map(({ token }) => flow.verify(token)))
      expect(valid.filter(Boolean)).toHaveLength(1)
    })

    test('mixed-case reissuance revokes the old token', async () => {
      const flow = flows()[index]
      const old = await flow.create()
      const next = await flow.create('Person@Example.Test')
      expect(await flow.verify(old.token)).toBeNull()
      expect(await flow.verify(next.token)).toBe(email)
    })

    test('does not resurrect a consumed token after callback failure', async () => {
      const flow = flows()[index]
      const { token } = await flow.create()
      await expect(flow.complete(token, async () => { throw new Error('write failed') })).rejects.toThrow('write failed')
      expect(await flow.verify(token)).toBeNull()
    })
  })
}

test('legacy custom stores fail closed rather than use a non-atomic fallback', async () => {
  const store: PasswordResetTokenStore = new MemoryPasswordResetStore()
  store.replace = undefined
  await expect(createPasswordResetToken(email, store)).rejects.toThrow('atomic store.replace')
  store.replace = MemoryPasswordResetStore.prototype.replace
  const { token } = await createPasswordResetToken(email, store)
  store.consume = undefined
  let updated = false
  await expect(completePasswordReset(token, 'synthetic', store, provider, async () => { updated = true })).rejects.toThrow('atomic store.consume')
  expect(updated).toBe(false)

  const verificationStore: EmailVerificationTokenStore = new MemoryEmailVerificationStore()
  const verification = await createEmailVerificationToken(email, verificationStore)
  verificationStore.replace = undefined
  verificationStore.consume = undefined
  await expect(createEmailVerificationToken(email, verificationStore)).rejects.toThrow('atomic store.replace')
  await expect(completeEmailVerification(verification.token, verificationStore, async () => { updated = true })).rejects.toThrow('atomic store.consume')
  expect(updated).toBe(false)
})
