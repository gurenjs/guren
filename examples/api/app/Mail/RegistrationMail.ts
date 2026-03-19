import { mail, getMailManager } from '@guren/server'

interface RegistrationMailData {
  email: string
  name: string
}

/**
 * Send a registration confirmation email.
 */
export async function sendRegistrationMail(data: RegistrationMailData): Promise<void> {
  const manager = getMailManager()
  if (!manager) {
    console.log(`[Mail] Would send registration email to ${data.email}`)
    return
  }

  await mail(manager)
    .to(data.email)
    .subject('Welcome to the API!')
    .html(`
      <h1>Welcome, ${data.name}!</h1>
      <p>Thank you for registering for our API service.</p>
      <p>You can now use your API token to access all endpoints.</p>
      <h2>Getting Started</h2>
      <ul>
        <li>Include your token in the Authorization header: <code>Bearer YOUR_TOKEN</code></li>
        <li>Check out the API documentation for available endpoints</li>
        <li>Create and manage your tasks via the /api/tasks endpoints</li>
      </ul>
    `)
    .text(`
Welcome, ${data.name}!

Thank you for registering for our API service.

You can now use your API token to access all endpoints.

Getting Started:
- Include your token in the Authorization header: Bearer YOUR_TOKEN
- Check out the API documentation for available endpoints
- Create and manage your tasks via the /api/tasks endpoints
    `)
    .send()
}
