import { Event } from '@guren/core'
import type { PostRecord } from '../Models/Post.js'
import type { UserRecord } from '../Models/User.js'

export class PostCreated extends Event {
  constructor(
    public readonly post: PostRecord,
    public readonly author: UserRecord
  ) {
    super()
  }
}
