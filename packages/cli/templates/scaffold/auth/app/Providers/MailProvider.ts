import { ServiceProvider, createMailManager } from '@guren/core'
import { mailConfig } from '../../config/mail.js'

export default class MailProvider extends ServiceProvider {
  register(): void {
    // The container is passed so queued mail stays on this app's queue.
    this.container.singleton('mail', (container) => createMailManager(mailConfig, container))
  }
}
