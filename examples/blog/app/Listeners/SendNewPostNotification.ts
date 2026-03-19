import { Listener } from '@guren/server'
import { PostCreated } from '../Events/PostCreated.js'

/**
 * Listener that sends notifications when a new post is created.
 * This listener is queued for background processing.
 */
export class SendNewPostNotification extends Listener<PostCreated> {
  static override event = PostCreated
  static override shouldQueue = true
  static override queue = 'notifications'
  static override priority = 0

  async handle(event: PostCreated): Promise<void> {
    const { post, author } = event
    // In a real app, this would send notifications to subscribers
    console.log(
      `[Notification] New post "${post.title}" created by ${author.name}`
    )
  }

  override shouldHandle(event: PostCreated): boolean {
    // Only notify if the post has a title (basic validation)
    return !!event.post.title
  }

  async failed(event: PostCreated, error: Error): Promise<void> {
    console.error(
      `[Notification] Failed to send notification for post "${event.post.title}":`,
      error.message
    )
  }
}
