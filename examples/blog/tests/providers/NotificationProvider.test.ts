import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Container } from '@guren/core'

const { notifications, mail, MailChannel, DatabaseChannel } = vi.hoisted(() => ({
  notifications: { registerChannel: vi.fn() },
  mail: { id: 'mail' },
  MailChannel: vi.fn(function MailChannel(this: { mail: unknown }, value: unknown) {
    this.mail = value
  }),
  DatabaseChannel: vi.fn(function DatabaseChannel() {}),
}))

vi.mock('@guren/core', async () => {
  const actual = await vi.importActual<typeof import('@guren/core')>('@guren/core')
  return {
    ...actual,
    MailChannel,
    DatabaseChannel,
  }
})

import NotificationProvider from '../../app/Providers/NotificationProvider.js'

describe('Blog NotificationProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('registers mail and database notification channels from the container', () => {
    const container = new Container()
    container.instance('notifications', notifications)
    container.instance('mail', mail)
    const provider = new NotificationProvider(container)

    provider.boot()

    expect(MailChannel).toHaveBeenCalledWith(mail)
    expect(DatabaseChannel).toHaveBeenCalledTimes(1)
    expect(notifications.registerChannel).toHaveBeenCalledTimes(2)
    expect(notifications.registerChannel).toHaveBeenCalledWith('mail', expect.any(Object))
    expect(notifications.registerChannel).toHaveBeenCalledWith('database', expect.any(Object))
  })
})
