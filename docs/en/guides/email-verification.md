# Email Verification Guide

Guren provides a secure email verification system with token generation, verification, and expiration. Tokens are hashed before storage for security.

## Core Concepts

- **EmailVerificationTokenStore** – Interface for storing verification tokens.
- **Token Hashing** – Tokens are hashed using SHA-256 before storage.
- **No Plain Storage** – Only token hashes are stored.
- **Single Use** – Tokens are deleted after successful verification.
- **Expiration** – Tokens expire after a configurable time (default: 24 hours).

## Basic Usage

### Creating a Verification Token

```ts
import { createEmailVerificationToken, MemoryEmailVerificationStore } from '@guren/core'

const store = new MemoryEmailVerificationStore() // Use database in production

// Create a verification token
const { token, expiresAt } = await createEmailVerificationToken(
  'user@example.com',
  store
)

// Send verification email
await sendVerificationEmail(email, token)
```

### Verifying a Token (Read-Only)

```ts
import { verifyEmailToken } from '@guren/core'

// Check if token is valid without consuming it
const email = await verifyEmailToken(token, store)

if (!email) {
  return ctx.json({ error: 'Invalid or expired token' }, 400)
}

// Token is valid, but not yet consumed
return ctx.json({ email, valid: true })
```

### Completing Verification

```ts
import { completeEmailVerification } from '@guren/core'

const user = await completeEmailVerification(
  token,
  store,
  async (email) => {
    // Mark user as verified
    await User.update(
      { email },
      { emailVerifiedAt: new Date() }
    )
    return User.findByEmail(email)
  }
)

if (!user) {
  return ctx.json({ error: 'Invalid or expired token' }, 400)
}

return ctx.redirect('/dashboard')
```

## Full Implementation Example

### Routes

```ts
import { Router } from '@guren/core'
import { VerificationController } from '@/app/Controllers/VerificationController'

export function registerWebRoutes(router: Router): void {
  router.middleware('auth').group((auth) => {
    auth.get('/email/verify', [VerificationController, 'notice'])
    auth.post('/email/resend', [VerificationController, 'resend'])
  })

  router.get('/email/verify/:token', [VerificationController, 'verify'])
}
```

### Controller

```ts
import { Controller } from '@guren/core'
import {
  createEmailVerificationToken,
  completeEmailVerification,
  buildVerificationUrl,
  isEmailVerified,
} from '@guren/core'
import { User } from '@/app/Models/User'
import { appPages } from '@/resources/js/pages/contracts'

export class VerificationController extends Controller {
  private store = new DatabaseEmailVerificationStore()

  async notice() {
    const user = await this.auth.user()

    if (isEmailVerified(user)) {
      return this.redirect('/dashboard')
    }

    return this.inertia(appPages.auth.verifyEmail, {
      email: user.email,
    })
  }

  async resend() {
    const user = await this.auth.user()

    if (isEmailVerified(user)) {
      return this.json({ message: 'Already verified' })
    }

    const { token } = await createEmailVerificationToken(
      user.email,
      this.store,
      { expiresIn: 24 * 60 * 60 * 1000 } // 24 hours
    )

    const verifyUrl = buildVerificationUrl(
      `${process.env.APP_URL}/email/verify`,
      token
    )

    await this.sendVerificationEmail(user, verifyUrl)

    return this.json({ message: 'Verification email sent' })
  }

  async verify() {
    const token = this.request.param('token')

    const user = await completeEmailVerification(
      token,
      this.store,
      async (email) => {
        await User.where('email', email).update({
          emailVerifiedAt: new Date(),
        })
        return User.where('email', email).first()
      }
    )

    if (!user) {
      return this.inertia(appPages.auth.verifyEmail, {
        error: 'Invalid or expired verification link',
      })
    }

    return this.redirect('/dashboard?verified=1')
  }

  private async sendVerificationEmail(user: User, verifyUrl: string) {
    await mail.send({
      to: user.email,
      subject: 'Verify Your Email Address',
      html: `
        <h1>Verify Your Email</h1>
        <p>Click the button below to verify your email address:</p>
        <a href="${verifyUrl}" style="...">Verify Email</a>
        <p>This link will expire in 24 hours.</p>
        <p>If you didn't create an account, no action is required.</p>
      `,
    })
  }
}
```

## Helper Functions

### Check Verification Status

```ts
import { isEmailVerified } from '@guren/core'

// Check if user is verified
if (isEmailVerified(user)) {
  // User's email is verified
}

// Works with nullable users
if (!isEmailVerified(null)) {
  // Returns false for null
}
```

### Require Verified Email Middleware

```ts
import { Router, requireVerifiedEmail } from '@guren/core'

const router = new Router()

// Redirect unverified users
router.get('/dashboard', [DashboardController, 'index']).middleware(
  requireVerifiedEmail({ redirectTo: '/email/verify' })
)

// Custom user getter
router.get('/profile', [ProfileController, 'show']).middleware(
  requireVerifiedEmail({
    redirectTo: '/verify-email',
    getUser: async (ctx) => {
      return ctx.get('user')
    },
  })
)
```

## URL Helpers

### Building Verification URLs

```ts
import { buildVerificationUrl } from '@guren/core'

// Basic URL with token
const url = buildVerificationUrl('https://example.com/verify', token)
// Result: https://example.com/verify?token=abc123...

// With email parameter
const urlWithEmail = buildVerificationUrl(
  'https://example.com/verify',
  token,
  'user@example.com'
)
// Result: https://example.com/verify?token=abc123...&email=user%40example.com
```

### Parsing Verification URLs

```ts
import { parseVerificationUrl } from '@guren/core'

const { token, email } = parseVerificationUrl(
  'https://example.com/verify?token=abc123&email=user%40example.com'
)

console.log(token) // 'abc123'
console.log(email) // 'user@example.com'
```

## Database Storage

### Implementing EmailVerificationTokenStore

```ts
import type { EmailVerificationTokenStore, EmailVerificationToken } from '@guren/core'
import { emailVerifications } from '@/db/schema'
import { eq } from 'drizzle-orm'

export class DatabaseEmailVerificationStore implements EmailVerificationTokenStore {
  async store(token: EmailVerificationToken): Promise<void> {
    await db.insert(emailVerifications).values({
      hashedToken: token.hashedToken,
      email: token.email,
      expiresAt: token.expiresAt,
      createdAt: token.createdAt,
    })
  }

  async findByHashedToken(hashedToken: string): Promise<EmailVerificationToken | null> {
    const result = await db.select()
      .from(emailVerifications)
      .where(eq(emailVerifications.hashedToken, hashedToken))
      .limit(1)

    if (!result[0]) return null

    return {
      email: result[0].email,
      hashedToken: result[0].hashedToken,
      expiresAt: result[0].expiresAt,
      createdAt: result[0].createdAt,
    }
  }

  async delete(hashedToken: string): Promise<void> {
    await db.delete(emailVerifications)
      .where(eq(emailVerifications.hashedToken, hashedToken))
  }

  async deleteForEmail(email: string): Promise<void> {
    await db.delete(emailVerifications)
      .where(eq(emailVerifications.email, email.toLowerCase()))
  }
}
```

### Database Schema

```ts
// db/schema.ts
import { pgTable, text, timestamp } from 'drizzle-orm/pg-core'

export const emailVerifications = pgTable('email_verifications', {
  hashedToken: text('hashed_token').primaryKey(),
  email: text('email').notNull(),
  expiresAt: timestamp('expires_at').notNull(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
})

// User table should include emailVerifiedAt
export const users = pgTable('users', {
  id: serial('id').primaryKey(),
  email: text('email').notNull().unique(),
  emailVerifiedAt: timestamp('email_verified_at'),
  // ... other fields
})
```

## Configuration

### Token Options

```ts
interface EmailVerificationConfig {
  /** Token expiration time in milliseconds (default: 24 hours) */
  expiresIn?: number
  /** Token byte length before hex encoding (default: 32) */
  tokenLength?: number
}

// Example with custom configuration
const { token } = await createEmailVerificationToken(email, store, {
  expiresIn: 48 * 60 * 60 * 1000, // 48 hours
  tokenLength: 64,
})
```

## Testing

```ts
import { describe, test, expect, beforeEach } from 'bun:test'
import {
  createEmailVerificationToken,
  verifyEmailToken,
  completeEmailVerification,
  isEmailVerified,
  MemoryEmailVerificationStore,
} from '@guren/core'

describe('Email Verification', () => {
  let store: MemoryEmailVerificationStore

  beforeEach(() => {
    store = new MemoryEmailVerificationStore()
  })

  test('creates and verifies token', async () => {
    const { token } = await createEmailVerificationToken('user@example.com', store)

    const email = await verifyEmailToken(token, store)

    expect(email).toBe('user@example.com')
  })

  test('normalizes email to lowercase', async () => {
    const { token } = await createEmailVerificationToken('User@Example.COM', store)

    const email = await verifyEmailToken(token, store)

    expect(email).toBe('user@example.com')
  })

  test('rejects expired tokens', async () => {
    const { token } = await createEmailVerificationToken('user@example.com', store, {
      expiresIn: -1000, // Already expired
    })

    const email = await verifyEmailToken(token, store)

    expect(email).toBeNull()
  })

  test('completes verification and consumes token', async () => {
    const { token } = await createEmailVerificationToken('user@example.com', store)

    const result = await completeEmailVerification(
      token,
      store,
      async (email) => ({ email, verified: true })
    )

    expect(result).toEqual({ email: 'user@example.com', verified: true })

    // Token should be consumed
    const secondAttempt = await verifyEmailToken(token, store)
    expect(secondAttempt).toBeNull()
  })

  test('isEmailVerified helper works correctly', () => {
    expect(isEmailVerified({ emailVerifiedAt: new Date() })).toBe(true)
    expect(isEmailVerified({ emailVerifiedAt: null })).toBe(false)
    expect(isEmailVerified(null)).toBe(false)
  })
})
```

## Registration Flow Example

```ts
// UserController.ts
async register() {
  const { name, email, password } = await this.validate({
    name: z.string().min(2),
    email: z.string().email(),
    password: z.string().min(8),
  })

  // Create user
  const user = await User.create({
    name,
    email,
    password: await Bun.password.hash(password),
    emailVerifiedAt: null,
  })

  // Create verification token
  const { token } = await createEmailVerificationToken(email, this.store)

  // Send verification email
  const verifyUrl = buildVerificationUrl(
    `${process.env.APP_URL}/email/verify`,
    token
  )
  await this.sendVerificationEmail(user, verifyUrl)

  // Log the user in
  await this.auth.login(user)

  // Redirect to verification notice
  return this.redirect('/email/verify')
}
```

## Best Practices

1. **Use longer expiration times**: Email verification tokens can safely expire in 24-72 hours.

2. **Normalize emails**: Store emails in lowercase to prevent case-sensitivity issues.

3. **Allow resending**: Let users request a new verification email if needed.

4. **Clear old tokens**: Creating a new token automatically deletes old ones for the same email.

5. **Protect routes**: Use `requireVerifiedEmail` middleware for routes that need verified users.

6. **Handle already verified**: Check `isEmailVerified()` before sending new tokens.

7. **Use database storage**: `MemoryEmailVerificationStore` is only for testing.

8. **Send during registration**: Automatically send verification email when users register.
