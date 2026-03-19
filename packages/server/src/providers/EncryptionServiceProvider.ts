import { ServiceProvider } from '../container/ServiceProvider'
import { createEncrypter } from '../encryption'

/**
 * Binds the Encrypter as a singleton in the container.
 */
export class EncryptionServiceProvider extends ServiceProvider {
  register(): void {
    this.container.singleton('encrypter', () => {
      const key = typeof process !== 'undefined' ? process.env.APP_KEY : undefined
      return createEncrypter({ key: key ?? '' })
    })
  }
}
