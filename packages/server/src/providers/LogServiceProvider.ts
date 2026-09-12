import { ServiceProvider } from '../container/ServiceProvider'
import { createLogManager } from '../logging'

/**
 * Binds the LogManager as a singleton in the container. The default channel is
 * declared, not merely named: `LogManager` resolves channels from `channels`
 * alone, so a `default` with no matching entry throws on the first write.
 * `getLogManager()` resolves it from the default application (RFC 0023 §4).
 */
export class LogServiceProvider extends ServiceProvider {
  register(): void {
    this.container.singleton('log', () => createLogManager({
      default: 'console',
      channels: { console: { driver: 'console' } },
    }))
  }
}
