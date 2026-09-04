import { ServiceProvider } from '../container/ServiceProvider'
import { createMailManager } from '../mail'

/** Binds the MailManager as a singleton in the container. */
export class MailServiceProvider extends ServiceProvider {
  register(): void {
    this.container.singleton('mail', () => createMailManager())
  }
}
