import { ServiceProvider } from '../container/ServiceProvider'
import { createOAuthManager } from '../auth/oauth'

/**
 * Binds OAuthManager as a singleton in the container.
 */
export class OAuthServiceProvider extends ServiceProvider {
  register(): void {
    this.container.singleton('oauth', () => createOAuthManager())
  }
}
