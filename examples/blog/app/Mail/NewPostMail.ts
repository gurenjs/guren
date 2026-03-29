import { mail, type MailManager } from '@guren/core'
import type { PostRecord } from '../Models/Post.js'
import type { UserRecord } from '../Models/User.js'

/**
 * Send a notification email about a new post.
 */
export async function sendNewPostMail(
  manager: MailManager,
  subscriber: { email: string; name: string },
  post: PostRecord,
  author: UserRecord
): Promise<void> {
  const body = post.body ?? ''
  await mail(manager)
    .to(subscriber.email)
    .subject(`New Post: ${post.title}`)
    .html(`
      <h1>New Post from ${author.name}</h1>
      <h2>${post.title}</h2>
      <p>${body.substring(0, 200)}${body.length > 200 ? '...' : ''}</p>
      <p><a href="/posts/${post.id}">Read More</a></p>
    `)
    .text(`
New Post from ${author.name}

${post.title}

${body.substring(0, 200)}${body.length > 200 ? '...' : ''}

Read more at: /posts/${post.id}
    `)
    .send()
}
