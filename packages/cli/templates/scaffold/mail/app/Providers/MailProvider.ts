import { ServiceProvider, createMailManager } from '@guren/core'

export default class MailProvider extends ServiceProvider {
  register(): void {
    // The container is passed so queued mail stays on this app's queue.
    this.container.singleton('mail', (container) =>
      createMailManager(
        {
          // MAIL_MAILER=log writes messages to the server output (default);
          // 'memory' keeps them inspectable in tests.
          default: process.env.MAIL_MAILER === 'memory' ? 'memory' : 'log',
          // `||`, not `??`: a blanked `MAIL_FROM_ADDRESS=` is '', which is no sender.
          from: {
            email: process.env.MAIL_FROM_ADDRESS || 'noreply@example.com',
            name: process.env.MAIL_FROM_NAME || 'Guren App',
          },
          transports: {
            log: { driver: 'log' },
            memory: { driver: 'memory' },
          },
        },
        container,
      ),
    )
  }
}
