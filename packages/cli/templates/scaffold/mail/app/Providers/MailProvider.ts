// oxlint-disable guren/no-unvalidated-env-read -- the provider form serves apps with no config/env.ts to declare these keys in
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
            // oxlint-disable-next-line guren/no-nullish-env-default -- an empty display name is a choice, not a missing value
            name: process.env.MAIL_FROM_NAME ?? 'Guren',
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
