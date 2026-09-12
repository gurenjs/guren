import { ServiceProvider } from '../container/ServiceProvider'
import { createMailManager } from '../mail'

/**
 * Binds the MailManager as a singleton in the container, on the `log`
 * transport: an app that never configured mail gets every message in the
 * server output rather than "Mail transport not found: smtp" on the first
 * send. The scaffolded `MailProvider` rebinds `mail` with the app's own
 * config, so this default only reaches apps that never ran `guren add mail`.
 */
export class MailServiceProvider extends ServiceProvider {
  register(): void {
    this.container.singleton('mail', (container) =>
      createMailManager(
        {
          default: 'log',
          transports: { log: { driver: 'log' } },
        },
        container,
      ),
    )
  }
}
