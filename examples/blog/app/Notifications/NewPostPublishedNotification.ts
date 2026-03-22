import { Notification, type Notifiable, type NotificationMailMessage } from '@guren/core'
import type { PostRecord } from '../Models/Post.js'

export class NewPostPublishedNotification extends Notification {
  constructor(private readonly post: PostRecord) {
    super()
  }

  via(notifiable: Notifiable): string[] {
    return notifiable.routeNotificationFor('mail') ? ['mail', 'database'] : ['database']
  }

  toMail(): NotificationMailMessage {
    return {
      subject: `New post published: ${this.post.title}`,
      text: `A new post is live: ${this.post.title}`,
    }
  }

  toDatabase(): Record<string, unknown> {
    return {
      postId: this.post.id,
      title: this.post.title,
      excerpt: this.post.excerpt,
    }
  }
}
