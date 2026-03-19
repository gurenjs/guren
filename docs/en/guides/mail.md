# Mail Guide

Guren provides a fluent API for sending emails with support for multiple transport backends. The mail system integrates with the queue system for async sending and supports HTML templates, attachments, and more.

## Core Concepts

- **MailManager** – Central registry for configuring and accessing mail transports.
- **Mail** – Fluent builder for composing and sending emails.
- **Transport** – Email delivery backend. Guren ships with SMTP, Resend, and Memory (testing) transports.

## Basic Usage

### Quick Start

```ts
import { MailManager, mail } from '@guren/core'

const mailManager = new MailManager({
  default: 'smtp',
  from: { email: 'noreply@example.com', name: 'MyApp' },
  transports: {
    smtp: {
      driver: 'smtp',
      host: 'smtp.example.com',
      port: 587,
      auth: { user: 'user', pass: 'password' },
    },
  },
})

// Send a simple email
await mail(mailManager)
  .to('user@example.com')
  .subject('Hello!')
  .text('Hello World!')
  .send()
```

### Fluent API

```ts
const builder = mail(mailManager)

// Recipients
builder.to('user@example.com')                    // Add recipient
builder.to({ email: 'user@example.com', name: 'John' })  // With name
builder.toMany(['a@example.com', 'b@example.com']) // Multiple recipients
builder.cc('copy@example.com')                    // CC recipient
builder.bcc('blind@example.com')                  // BCC recipient

// Sender and reply
builder.from('sender@example.com')                // Override default from
builder.replyTo('support@example.com')            // Reply-to address

// Content
builder.subject('Welcome!')                       // Email subject
builder.text('Plain text body')                   // Plain text
builder.html('<h1>HTML body</h1>')               // HTML content

// Attachments
builder.attach({
  filename: 'report.pdf',
  path: './storage/report.pdf',
})
builder.attach({
  filename: 'data.json',
  content: JSON.stringify(data),
  contentType: 'application/json',
})

// Headers
builder.header('X-Custom-Header', 'value')

// Send
await builder.send()
```

## Configuration

### Multiple Transports

Configure multiple mail backends for different use cases:

```ts
import { MailManager, mail } from '@guren/core'

const mailManager = new MailManager({
  default: 'smtp',
  from: { email: 'noreply@example.com', name: 'MyApp' },
  transports: {
    smtp: {
      driver: 'smtp',
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT) || 587,
      secure: process.env.SMTP_SECURE === 'true',
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
      },
    },
    resend: {
      driver: 'resend',
      apiKey: process.env.RESEND_API_KEY,
    },
    memory: {
      driver: 'memory',
    },
  },
})

// Use default transport (smtp)
await mail(mailManager).to('user@example.com').subject('Test').text('Hello').send()

// Use specific transport
await mail(mailManager)
  .via('resend')
  .to('user@example.com')
  .subject('Via Resend')
  .text('Hello')
  .send()
```

### Transport Options

**SMTP Transport:**
| Option | Default | Description |
|--------|---------|-------------|
| `host` | required | SMTP server hostname |
| `port` | `587` | SMTP server port |
| `secure` | `false` | Use TLS (usually for port 465) |
| `auth.user` | - | SMTP username |
| `auth.pass` | - | SMTP password |
| `pool` | `true` | Use connection pooling |
| `maxConnections` | `5` | Max pool connections |

**Resend Transport:**
| Option | Default | Description |
|--------|---------|-------------|
| `apiKey` | required | Resend API key |

**Memory Transport (Testing):**
| Option | Default | Description |
|--------|---------|-------------|
| `simulateFailure` | `false` | Simulate send failures |
| `failureMessage` | - | Error message for failures |

## HTML Templates

### Using React Email

Guren integrates with [React Email](https://react.email/) for type-safe email templates:

```bash
bun add @react-email/render react
```

```tsx
// app/Mail/WelcomeEmail.tsx
import * as React from 'react'
import { Html, Head, Body, Container, Text, Button } from '@react-email/components'

interface WelcomeEmailProps {
  name: string
  loginUrl: string
}

export function WelcomeEmail({ name, loginUrl }: WelcomeEmailProps) {
  return (
    <Html>
      <Head />
      <Body style={{ fontFamily: 'sans-serif' }}>
        <Container>
          <Text>Hello {name}!</Text>
          <Text>Welcome to our application.</Text>
          <Button href={loginUrl}>Get Started</Button>
        </Container>
      </Body>
    </Html>
  )
}
```

```ts
import { mail } from '@guren/core'
import { WelcomeEmail } from '@/app/Mail/WelcomeEmail'

await mail(mailManager)
  .to('user@example.com')
  .subject('Welcome!')
  .template(WelcomeEmail, { name: 'John', loginUrl: 'https://example.com/login' })
  .send()
```

### Using Plain HTML

```ts
await mail(mailManager)
  .to('user@example.com')
  .subject('Welcome!')
  .html(`
    <h1>Welcome, ${user.name}!</h1>
    <p>Thank you for signing up.</p>
    <a href="${loginUrl}">Get Started</a>
  `)
  .send()
```

## Attachments

```ts
// File attachment
await mail(mailManager)
  .to('user@example.com')
  .subject('Your Report')
  .text('Please find your report attached.')
  .attach({
    filename: 'report.pdf',
    path: './storage/reports/monthly.pdf',
  })
  .send()

// Inline content
await mail(mailManager)
  .to('user@example.com')
  .subject('Data Export')
  .text('Your data export is ready.')
  .attach({
    filename: 'data.json',
    content: JSON.stringify(exportData, null, 2),
    contentType: 'application/json',
  })
  .send()

// Inline images (CID)
await mail(mailManager)
  .to('user@example.com')
  .subject('Newsletter')
  .html('<img src="cid:logo" alt="Logo" /><p>Welcome!</p>')
  .attach({
    filename: 'logo.png',
    path: './public/logo.png',
    cid: 'logo',
  })
  .send()
```

## Queued Emails

Send emails asynchronously using the queue system:

```ts
import { mail, setMailManager, setQueueDriver, MemoryDriver } from '@guren/core'

// Configure queue driver
setQueueDriver(new MemoryDriver())

// Set global mail manager for queue jobs
setMailManager(mailManager)

// Queue the email instead of sending immediately
await mail(mailManager)
  .to('user@example.com')
  .subject('Weekly Report')
  .html(reportHtml)
  .queue('emails')  // Queue name

// The email will be processed by a worker
// bunx guren queue:work --queue=emails
```

## Mailable Classes

Generate mailable classes for reusable email templates:

```bash
bunx guren make:mail WelcomeMail
```

```ts
// app/Mail/WelcomeMail.ts
import { Mail, MailManager } from '@guren/core'

interface WelcomeMailData {
  user: { name: string; email: string }
  loginUrl: string
}

export class WelcomeMail {
  constructor(
    private readonly manager: MailManager,
    private readonly data: WelcomeMailData
  ) {}

  async send(): Promise<void> {
    const { user, loginUrl } = this.data

    await new Mail(this.manager)
      .to(user.email)
      .subject(`Welcome, ${user.name}!`)
      .html(`
        <h1>Welcome to MyApp!</h1>
        <p>Hi ${user.name},</p>
        <p>Thank you for joining us.</p>
        <a href="${loginUrl}">Get Started</a>
      `)
      .send()
  }

  async queue(queueName: string = 'emails'): Promise<string> {
    const { user, loginUrl } = this.data

    return new Mail(this.manager)
      .to(user.email)
      .subject(`Welcome, ${user.name}!`)
      .html(`
        <h1>Welcome to MyApp!</h1>
        <p>Hi ${user.name},</p>
        <p>Thank you for joining us.</p>
        <a href="${loginUrl}">Get Started</a>
      `)
      .queue(queueName)
  }
}

// Usage
const welcomeMail = new WelcomeMail(mailManager, {
  user: { name: 'John', email: 'john@example.com' },
  loginUrl: 'https://example.com/login',
})

await welcomeMail.send()
// or
await welcomeMail.queue('emails')
```

## Testing

Use the Memory transport for testing:

```ts
import { describe, test, expect, beforeEach } from 'bun:test'
import { MailManager, mail, MemoryTransport } from '@guren/core'

describe('Email', () => {
  let mailManager: MailManager
  let memoryTransport: MemoryTransport

  beforeEach(() => {
    memoryTransport = new MemoryTransport()

    mailManager = new MailManager({
      default: 'memory',
      from: { email: 'test@example.com' },
    })
    mailManager.registerTransport('memory', () => memoryTransport)
  })

  test('sends welcome email', async () => {
    await mail(mailManager)
      .to('user@example.com')
      .subject('Welcome!')
      .text('Hello World!')
      .send()

    const sent = memoryTransport.getSentMessages()
    expect(sent).toHaveLength(1)
    expect(sent[0].to[0].email).toBe('user@example.com')
    expect(sent[0].subject).toBe('Welcome!')
  })

  test('sends email with attachment', async () => {
    await mail(mailManager)
      .to('user@example.com')
      .subject('Report')
      .text('See attached.')
      .attach({ filename: 'data.txt', content: 'test data' })
      .send()

    const sent = memoryTransport.getSentMessages()
    expect(sent[0].attachments).toHaveLength(1)
    expect(sent[0].attachments![0].filename).toBe('data.txt')
  })
})
```

## Best Practices

1. **Use environment variables**: Never hardcode SMTP credentials or API keys.

2. **Set a default from address**: Configure a default sender to avoid repetition.

3. **Use queued sending for bulk emails**: Avoid blocking requests with synchronous sends.

4. **Use React Email for complex templates**: Type-safe templates are easier to maintain.

5. **Test with Memory transport**: Never send real emails in tests.

6. **Handle send failures**: Check the `SendResult` and implement retry logic for critical emails.

7. **Use meaningful subjects**: Clear subjects improve email deliverability and user experience.
