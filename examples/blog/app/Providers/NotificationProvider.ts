import {
  ServiceProvider,
  DatabaseChannel,
  MailChannel,
  type MailManager,
  type NotificationManager,
} from '@guren/core'

export default class NotificationProvider extends ServiceProvider {
  register(): void {}

  boot(): void {
    const notifications = this.container.make<NotificationManager>('notifications')
    const mail = this.container.make<MailManager>('mail')

    notifications.registerChannel('mail', new MailChannel(mail))
    notifications.registerChannel('database', new DatabaseChannel())
  }
}
