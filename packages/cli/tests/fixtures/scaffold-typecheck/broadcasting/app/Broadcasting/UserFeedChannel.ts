// Companion for typechecking templates/scaffold/broadcasting: what
// makeChannel('UserFeed', { channel: 'users.{id}.feed', private: true })
// emits. Pinned to the builder by scaffold-output.test.ts, so a builder
// change fails there with instructions rather than silently drifting from
// this copy.
import { PrivateChannel, type BroadcastManager } from '@guren/core'

export default class UserFeedChannel extends PrivateChannel {
  constructor(manager: BroadcastManager) {
    super('users.{id}.feed', manager.driver())
  }

  /**
   * Decide who may subscribe. Register it so it runs:
   *   broadcast.privateChannel(channel.getBaseName(), (name, user) => channel.authorize(name, user))
   */
  async authorize(channelName: string, user: unknown): Promise<boolean> {
    if (!user) return false

    // `users.{id}.feed` is per-user: only the owner may subscribe.
    return channelName === `private-users.${(user as { id: string | number }).id}.feed`
  }
}
