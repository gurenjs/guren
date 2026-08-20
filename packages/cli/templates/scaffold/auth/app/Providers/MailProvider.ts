import { ServiceProvider, createMailManager } from '@guren/core'
import { mailConfig } from '../../config/mail.js'

export default class MailProvider extends ServiceProvider {
  register(): void {
    this.container.singleton('mail', () => createMailManager(mailConfig))
  }
}
