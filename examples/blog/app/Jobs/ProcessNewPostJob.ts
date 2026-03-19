import { Job, createEventManager } from '@guren/server'
import { Post } from '../Models/Post.js'
import { User } from '../Models/User.js'
import { PostCreated } from '../Events/PostCreated.js'

interface ProcessNewPostPayload {
  postId: number
}

/**
 * Job that processes a newly created post.
 * This emits the PostCreated event for listeners to handle.
 */
export class ProcessNewPostJob extends Job<ProcessNewPostPayload> {
  static override queue = 'default'
  static override maxAttempts = 3
  static override backoff: 'exponential' = 'exponential'

  private events = createEventManager()

  async handle(payload: ProcessNewPostPayload): Promise<void> {
    const post = await Post.find(payload.postId)
    if (!post) {
      console.log(`[Job] Post ${payload.postId} not found, skipping processing`)
      return
    }

    const author = await User.find(post.authorId)
    if (!author) {
      console.log(`[Job] Author for post ${payload.postId} not found`)
      return
    }

    // Emit PostCreated event
    await this.events.emit(new PostCreated(post, author))
    console.log(`[Job] Post ${post.id} processed successfully`)
  }

  async failed(payload: ProcessNewPostPayload, error: Error): Promise<void> {
    console.error(
      `[Job] Failed to process post ${payload.postId}:`,
      error.message
    )
  }
}
