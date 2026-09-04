import { ServiceProvider } from '../container/ServiceProvider'
import { createEncrypter } from '../encryption'
import { deriveAppKeyring, encodeDerivedKey, getAppKeyringFromEnv } from '../encryption/app-key'

/** Binds the Encrypter as a singleton in the container. */
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
