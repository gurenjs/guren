import { Event } from '@guren/server'
import type { PostRecord } from '../Models/Post.js'
import type { UserRecord } from '../Models/User.js'

/**
 * Event fired when a new post is created.
 */
export class PostCreated extends Event {
  constructor(
    public readonly post: PostRecord,
    public readonly author: UserRecord
  ) {
    super()
  }
}
