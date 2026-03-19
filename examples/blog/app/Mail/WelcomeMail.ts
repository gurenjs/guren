import { mail, getMailManager } from '@guren/server'
import type { UserRecord } from '../Models/User.js'

/**
 * Send a welcome email to a newly registered user.
 */
export async function sendWelcomeMail(user: UserRecord): Promise<void> {
  const manager = getMailManager()
  if (!manager) {
    console.log(`[Mail] Would send welcome email to ${user.email}`)
    return
  }

  await mail(manager)
    .to(user.email)
    .subject('Welcome to our Blog!')
    .html(`
      <h1>Welcome, ${user.name}!</h1>
      <p>Thank you for joining our blog platform.</p>
      <p>You can now:</p>
      <ul>
        <li>Create and publish blog posts</li>
        <li>Edit your profile</li>
        <li>Explore posts from other authors</li>
      </ul>
      <p>Start by visiting your dashboard and creating your first post!</p>
    `)
    .text(`
Welcome, ${user.name}!

Thank you for joining our blog platform.

You can now:
- Create and publish blog posts
- Edit your profile
- Explore posts from other authors

Start by visiting your dashboard and creating your first post!
    `)
    .send()
}
