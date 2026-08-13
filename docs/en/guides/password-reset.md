# Password Reset Guide

Guren provides a secure password reset system with token generation, verification, and expiration. Tokens are hashed before storage for security.

## Core Concepts

- **PasswordResetTokenStore** – Interface for storing password reset tokens.
- **Token Hashing** – Tokens are hashed using SHA-256/SHA-512 before storage.
- **Automatic Cleanup** – Creating a new token invalidates any existing tokens for the same email.
- **Expiration** – Tokens expire after a configurable time (default: 1 hour).

## Basic Usage

### Creating a Password Reset Token

```ts
import { createPasswordResetToken, MemoryPasswordResetStore } from '@guren/core'

const store = new MemoryPasswordResetStore() // Use database in production

// Create a password reset token
const { token, expiresAt } = await createPasswordResetToken(
  'user@example.com',
  store
)

// Send the token to the user via email
await sendPasswordResetEmail(email, token)
```

### Verifying a Token

```ts
import { verifyPasswordResetToken } from '@guren/core'

// Verify the token from the reset URL
const email = await verifyPasswordResetToken(token, store)

if (!email) {
  return ctx.json({ error: 'Invalid or expired token' }, 400)
}

// Token is valid, show password reset form
return ctx.json({ email })
```

### Completing the Password Reset

```ts
import { completePasswordReset } from '@guren/core'

const user = await completePasswordReset(
  token,
  newPassword,
  store,
  userProvider,
  async (user, password) => {
    // Hash and update the password
    user.password = await hashPassword(password)
    await user.save()
  }
)

if (!user) {
  return ctx.json({ error: 'Invalid token or user not found' }, 400)
}

return ctx.json({ message: 'Password updated successfully' })
```

## Full Implementation Example

### Routes

```ts
import { Router } from '@guren/core'
import { PasswordResetController } from '@/app/Controllers/PasswordResetController'

export function registerWebRoutes(router: Router): void {
  router.post('/forgot-password', [PasswordResetController, 'sendResetLink'])
  router.get('/reset-password', [PasswordResetController, 'showResetForm'])
  router.post('/reset-password', [PasswordResetController, 'resetPassword'])
}
```

### Controller

```ts
 import { Controller } from '@guren/core'
 import { z } from 'zod'
import {
  createPasswordResetToken,
  verifyPasswordResetToken,
  completePasswordReset,
  buildPasswordResetUrl,
} from '@guren/core'
import { User } from '@/app/Models/User'
import { pages } from '@/.guren/pages.gen'

const ForgotPasswordSchema = z.object({
  email: z.email(),
})

const ResetPasswordSchema = z.object({
  token: z.string().min(1),
  password: z.string().min(8),
})

export class PasswordResetController extends Controller {
  private store = new DatabasePasswordResetStore()
  private userProvider = new EloquentUserProvider(User)

  async sendResetLink() {
    const { email } = await this.validateBody(ForgotPasswordSchema)

    // Always return success to prevent email enumeration
    const user = await User.where('email', email).first()

    if (user) {
      const { token } = await createPasswordResetToken(email, this.store, {
        expiresIn: 60 * 60 * 1000, // 1 hour
      })

      const resetUrl = buildPasswordResetUrl(
        `${process.env.APP_URL}/reset-password`,
        token,
        email
      )

      await this.sendResetEmail(user, resetUrl)
    }

    return this.json({
      message: 'If your email is registered, you will receive a reset link',
    })
  }

  async showResetForm() {
    const token = this.request.query('token')
    const email = await verifyPasswordResetToken(token, this.store)

    if (!email) {
      return this.inertia(pages.auth.ResetPassword, {
        error: 'Invalid or expired reset link',
      })
    }

    return this.inertia(pages.auth.ResetPassword, { token, email })
  }

  async resetPassword() {
    const { token, password } = await this.validateBody(ResetPasswordSchema)

    const user = await completePasswordReset(
      token,
      password,
      this.store,
      this.userProvider,
      async (user, newPassword) => {
        user.password = await Bun.password.hash(newPassword)
        await user.save()
      }
    )

    if (!user) {
      return this.json({ error: 'Invalid or expired token' }, 400)
    }

    return this.json({ message: 'Password has been reset' })
  }

  private async sendResetEmail(user: User, resetUrl: string) {
    await mail.send({
      to: user.email,
      subject: 'Reset Your Password',
      html: `
        <h1>Password Reset Request</h1>
        <p>Click the link below to reset your password:</p>
        <a href="${resetUrl}">Reset Password</a>
        <p>This link will expire in 1 hour.</p>
        <p>If you didn't request this, please ignore this email.</p>
      `,
    })
  }
}
```

## URL Helpers

### Building Reset URLs

```ts
import { buildPasswordResetUrl } from '@guren/core'

// Basic URL with token
const url = buildPasswordResetUrl('https://example.com/reset', token)
// Result: https://example.com/reset?token=abc123...

// With email parameter
const urlWithEmail = buildPasswordResetUrl(
  'https://example.com/reset',
  token,
  'user@example.com'
)
// Result: https://example.com/reset?token=abc123...&email=user%40example.com
```

### Parsing Reset URLs

```ts
import { parsePasswordResetUrl } from '@guren/core'

const { token, email } = parsePasswordResetUrl(
  'https://example.com/reset?token=abc123&email=user%40example.com'
)

console.log(token) // 'abc123'
console.log(email) // 'user@example.com'
```

## Database Storage

### Implementing PasswordResetTokenStore

```ts
import type { PasswordResetTokenStore } from '@guren/core'
import { passwordResets } from '@/db/schema'
import { eq, lt } from 'drizzle-orm'

export class DatabasePasswordResetStore implements PasswordResetTokenStore {
  async store(tokenHash: string, email: string, expiresAt: Date): Promise<void> {
    await db.insert(passwordResets).values({
      tokenHash,
      email,
      expiresAt,
      createdAt: new Date(),
    })
  }

  async find(tokenHash: string): Promise<{ email: string; expiresAt: Date } | null> {
    const result = await db.select()
      .from(passwordResets)
      .where(eq(passwordResets.tokenHash, tokenHash))
      .limit(1)

    if (!result[0]) return null

    // Check if expired
    if (result[0].expiresAt < new Date()) {
      await this.delete(tokenHash)
      return null
    }

    return {
      email: result[0].email,
      expiresAt: result[0].expiresAt,
    }
  }

  async delete(tokenHash: string): Promise<void> {
    await db.delete(passwordResets)
      .where(eq(passwordResets.tokenHash, tokenHash))
  }

  async deleteForEmail(email: string): Promise<void> {
    await db.delete(passwordResets)
      .where(eq(passwordResets.email, email))
  }

  // Optional: Clean up expired tokens
  async cleanupExpired(): Promise<void> {
    await db.delete(passwordResets)
      .where(lt(passwordResets.expiresAt, new Date()))
  }
}
```

### Database Schema

```ts
// db/schema.ts
import { pgTable, text, timestamp } from '@guren/orm/drizzle/pg'

export const passwordResets = pgTable('password_resets', {
  tokenHash: text('token_hash').primaryKey(),
  email: text('email').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})
```

## Configuration

### Token Options

```ts
interface PasswordResetConfig {
  /** Token expiration time in milliseconds (default: 1 hour) */
  expiresIn?: number
  /** Hash algorithm (default: 'sha256') */
  hashAlgorithm?: 'sha256' | 'sha512'
  /** Token byte length before encoding (default: 32) */
  tokenLength?: number
}

// Example with custom configuration
const { token } = await createPasswordResetToken(email, store, {
  expiresIn: 30 * 60 * 1000, // 30 minutes
  hashAlgorithm: 'sha512',
  tokenLength: 64,
})
```

## Testing

```ts
import { describe, test, expect, beforeEach } from 'bun:test'
import {
  createPasswordResetToken,
  verifyPasswordResetToken,
  completePasswordReset,
  MemoryPasswordResetStore,
} from '@guren/core'

describe('Password Reset', () => {
  let store: MemoryPasswordResetStore

  beforeEach(() => {
    store = new MemoryPasswordResetStore()
  })

  test('creates and verifies token', async () => {
    const { token } = await createPasswordResetToken('user@example.com', store)

    const email = await verifyPasswordResetToken(token, store)

    expect(email).toBe('user@example.com')
  })

  test('rejects expired tokens', async () => {
    const { token } = await createPasswordResetToken('user@example.com', store, {
      expiresIn: -1000, // Already expired
    })

    const email = await verifyPasswordResetToken(token, store)

    expect(email).toBeNull()
  })

  test('invalidates previous tokens on new request', async () => {
    const { token: oldToken } = await createPasswordResetToken('user@example.com', store)
    const { token: newToken } = await createPasswordResetToken('user@example.com', store)

    expect(await verifyPasswordResetToken(oldToken, store)).toBeNull()
    expect(await verifyPasswordResetToken(newToken, store)).toBe('user@example.com')
  })

  test('token can only be used once', async () => {
    const { token } = await createPasswordResetToken('user@example.com', store)

    // First use
    const user = await completePasswordReset(
      token,
      'new-password',
      store,
      userProvider,
      async (u, p) => { u.password = p }
    )
    expect(user).not.toBeNull()

    // Second use should fail
    const email = await verifyPasswordResetToken(token, store)
    expect(email).toBeNull()
  })
})
```

## Best Practices

1. **Always return success on forgot password**: Prevent email enumeration attacks by always showing a success message.

2. **Use short expiration times**: Password reset tokens should expire quickly (15-60 minutes).

3. **Invalidate on password change**: When a user changes their password, delete all their reset tokens.

4. **Rate limit requests**: Prevent abuse by rate limiting the forgot password endpoint.

5. **Use HTTPS**: Reset links contain sensitive tokens and must be sent over HTTPS.

6. **Don't include password in email**: Only send the reset link, never the new password.

7. **Log reset attempts**: Log password reset requests for security auditing.

8. **Notify user of password changes**: Send an email when the password is successfully changed.
