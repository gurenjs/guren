import { Event } from '@guren/core'

/** Sent when one post's content changes; its show page reloads the `post` prop on it. */
export class PostUpdated extends Event {
  static override eventName = 'PostUpdated'

  constructor(public readonly postId: number) {
    super()
  }

  broadcastOn(): string[] {
    return [`private-posts.${this.postId}`]
  }

  // Everyone on the channel receives the payload, so it carries the id only.
  broadcastWith(): Record<string, unknown> {
    return { postId: this.postId }
  }
}
