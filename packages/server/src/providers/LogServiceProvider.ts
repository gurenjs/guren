import { ServiceProvider } from '../container/ServiceProvider'
import { createLogManager, setLogManager, type LogManager } from '../logging'

/**
 * Binds the LogManager as a singleton in the container and, at boot, makes it
 * the global one behind `getLogManager()`. The default channel is declared,
 * not merely named: `LogManager` resolves channels from `channels` alone, so a
 * `default` with no matching entry throws on the first write.
 */
export class LogServiceProvider extends ServiceProvider {
  register(): void {
    this.container.singleton('log', () => createLogManager({
      default: 'console',
      channels: { console: { driver: 'console' } },
    }))
  }

  boot(): void {
    setLogManager(this.container.make<LogManager>('log'))
  }
}
