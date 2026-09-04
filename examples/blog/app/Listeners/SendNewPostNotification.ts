import { Listener, type BroadcastManager, type NotificationManager, type Notifiable, type StorageManager } from '@guren/core'
import { PostCreated } from '../Events/PostCreated.js'
import { NewPostPublishedNotification } from '../Notifications/NewPostPublishedNotification.js'

export class SendNewPostNotification extends Listener<PostCreated> {
  static override event = PostCreated
  static override shouldQueue = true
  static override queue = 'notifications'
  static override priority = 0

  constructor(
    private readonly notifications: NotificationManager,
    private readonly broadcast: BroadcastManager,
    private readonly storage: StorageManager,
  ) {
    super()
  }

  async handle(event: PostCreated): Promise<void> {
    const { post, author } = event
    const payload = {
      postId: post.id,
      title: post.title,
      authorId: author.id,
      authorName: author.name,
    }

    const recipient: Notifiable = {
      notifications: [],
      routeNotificationFor(channel: string): string | null {
        if (channel === 'mail') return author.email
        return null
      },
    }

    await this.storage.disk('public').put(`notifications/posts/${post.id}.json`, JSON.stringify(payload))
    await this.notifications.sendNow(recipient, new NewPostPublishedNotification(post))
    await this.broadcast.broadcast('announcements', 'post.created', payload)
    await this.broadcast.broadcast(`posts.${post.id}`, 'post.created', payload)

    console.log(
      `[Notification] New post "${post.title}" created by ${author.name}`
    )
  }

  override shouldHandle(event: PostCreated): boolean {
    return !!event.post.title
  }

  async failed(event: PostCreated, error: Error): Promise<void> {
    console.error(
      `[Notification] Failed to send notification for post "${event.post.title}":`,
      error.message
    )
  }
}
