import { ServiceProvider } from '../container/ServiceProvider'
import { createEncrypter } from '../encryption'
import { deriveAppKeyring, encodeDerivedKey, getAppKeyringFromEnv } from '../encryption/app-key'

/**
 * Binds the Encrypter as a singleton. `encrypt()` / `decrypt()` /
 * `getEncrypter()` resolve it from the default application's container
 * (RFC 0023 §4), so no global is written. The keyring is read lazily, so a
 * provider registering later can still replace `app.keyring` before the
 * encrypter is built.
 */
export class EncryptionServiceProvider extends ServiceProvider {
  register(): void {
    if (!this.container.has('app.keyring')) {
      this.container.instance('app.keyring', getAppKeyringFromEnv())
    }

    this.container.singleton('encrypter', () => {
      const keyring = deriveAppKeyring(this.container.make('app.keyring'), 'data-encryption')
      return createEncrypter({
        key: encodeDerivedKey(keyring.current),
        previousKeys: keyring.previous.map((key) => encodeDerivedKey(key)),
      })
    })
  }
}
