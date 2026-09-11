import { ServiceProvider } from '../container/ServiceProvider'
import { createEncrypter, setEncrypter, type Encrypter } from '../encryption'
import { deriveAppKeyring, encodeDerivedKey, getAppKeyringFromEnv } from '../encryption/app-key'

/**
 * Binds the Encrypter as a singleton in the container and, at boot, makes it
 * the global one behind `encrypt()` / `decrypt()` / `getEncrypter()`. The
 * global is set in `boot()` rather than `register()` so a provider registering
 * later can still replace `app.keyring` before the encrypter is built.
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

  boot(): void {
    setEncrypter(this.container.make<Encrypter>('encrypter'))
  }
}
