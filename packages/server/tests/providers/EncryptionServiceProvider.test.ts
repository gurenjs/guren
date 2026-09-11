import { describe, expect, it } from 'bun:test'
import { createApp } from '../../src/http/Application'
import { EncryptionServiceProvider } from '../../src/providers/EncryptionServiceProvider'
import { decrypt, encrypt, getEncrypter, type Encrypter } from '../../src/encryption'

process.env.APP_KEY ??= 'base64:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='

describe('EncryptionServiceProvider', () => {
  it('should make the bound encrypter the one behind encrypt() and decrypt() once the app boots', async () => {
    const app = createApp({ providers: [EncryptionServiceProvider] })
    await app.boot()

    const payload = encrypt({ userId: 7 })

    expect(decrypt<{ userId: number }>(payload)).toEqual({ userId: 7 })
    expect(getEncrypter()).toBe(app.container.make<Encrypter>('encrypter'))
  })
})
