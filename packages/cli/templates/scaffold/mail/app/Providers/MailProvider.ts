import { ServiceProvider, createMailManager, setMailManager, type MailManager } from '@guren/core'

export default class MailProvider extends ServiceProvider {
  register(): void {
    const manager = createMailManager({
      // MAIL_MAILER=log writes messages to the server output (default);
      // 'memory' keeps them inspectable in tests.
      default: process.env.MAIL_MAILER === 'memory' ? 'memory' : 'log',
      from: { email: 'noreply@example.com', name: 'Guren App' },
      transports: {
        log: { driver: 'log' },
        memory: { driver: 'memory' },
      },
    })

    this.container.instance('mail', manager)
  }

  boot(): void {
    const manager = this.container.make<MailManager>('mail')
    setMailManager(manager)
  }
}
