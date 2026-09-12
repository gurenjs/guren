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
          from: { email: 'noreply@example.com', name: 'Guren App' },
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
