import { Event } from '@guren/core'

/** Sent whenever the post list changes; the posts index reloads its live props on it. */
export class PostsChanged extends Event {
  static override eventName = 'PostsChanged'

  broadcastOn(): string[] {
    return ['posts']
  }
}
