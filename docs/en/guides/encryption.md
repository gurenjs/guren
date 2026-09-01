# Encryption & Hashing

Guren provides utilities for encrypting data and hashing passwords securely.

## APP_KEY

Every Guren application needs an `APP_KEY` — a base64-encoded 32-byte secret used for encryption, cookie signing, and token signing. Guren uses HKDF to derive separate keys for each purpose, so a single `APP_KEY` secures all subsystems without sharing raw key material.

### Generating a Key

```bash
# Generate and print a key
bunx guren key:generate

# Generate and write directly to .env
bunx guren key:generate --write
```

`create-guren-app` generates an `APP_KEY` automatically when scaffolding a new project.

### Key Rotation

To rotate your `APP_KEY` without breaking existing encrypted data or active sessions:

1. Move the current `APP_KEY` value to `APP_PREVIOUS_KEYS`
2. Generate a new `APP_KEY`

```bash
# .env
APP_KEY=base64:<new-key>
APP_PREVIOUS_KEYS=base64:<old-key>
```

Multiple previous keys can be comma-separated. Guren will try the current key first, then fall back to previous keys when decrypting data or verifying signatures.

## Encryption

The `Encrypter` class provides AES-256-GCM encryption for sensitive data.

### Setup

Create an encrypter with a 32-byte key:

```typescript
import { Encrypter, generateKey } from '@guren/core'

// Generate a new key
const key = generateKey()
console.log(key) // base64:... (32-byte key)

// Create encrypter
const encrypter = new Encrypter({ key })

// With key rotation support
const rotatedEncrypter = new Encrypter({
  key: newKey,
  previousKeys: [oldKey],
})
```

### Encrypting Data

```typescript
// Encrypt any value (objects are JSON-serialized automatically)
const encrypted = encrypter.encrypt({ userId: 1, token: 'abc123' })

// Encrypt a raw string without serialization
const encryptedString = encrypter.encryptString('secret message')
```

### Decrypting Data

```typescript
// Decrypt (automatically deserializes JSON)
const data = encrypter.decrypt(encrypted)
// Returns: { userId: 1, token: 'abc123' }

// Decrypt a raw string
const message = encrypter.decryptString(encryptedString)
// Returns: 'secret message'
```

### Key Management

```typescript
import { generateKey, Encrypter } from '@guren/core'

// Generate a cryptographically secure key
const key = generateKey()

// Get the current key
const currentKey = encrypter.getKey()
```

Store your encryption key securely in environment variables:

```bash
# .env
APP_KEY=base64:your-32-byte-key-here
```

### Error Handling

```typescript
import { Encrypter } from '@guren/core'

try {
  const decrypted = encrypter.decrypt(invalidPayload)
} catch (error) {
  console.error('Decryption failed:', (error as Error).message)
}
```

## Hashing

Password hashing goes through a `PasswordHasher`. Three implementations ship:

| Class | Algorithm | Runtime |
| --- | --- | --- |
| `Hash` (alias of `DefaultHasher`) | Delegates to `ScryptHasher` on Bun, `NodeHasher` elsewhere | Both |
| `ScryptHasher` | `Bun.password` — Argon2id by default, bcrypt on request | Bun only |
| `NodeHasher` | `crypto.scrypt` | Any |

Reach for `Hash` unless you have a reason not to: it is the only one that works both on Bun and on a Node runtime such as AWS Lambda, and it is what `AuthenticatableModel` and `ModelUserProvider` use by default.

> `ScryptHasher` produces Argon2id, not scrypt. The name predates the implementation; only `NodeHasher` uses scrypt.

The two runtimes produce different hash formats, so a hash written under one cannot be verified under the other. That only matters for an app that moves an existing password column between runtimes.

### Creating a Hasher

```typescript
import { Hash } from '@guren/core'

// Runtime-detecting. Takes no options.
const hash = new Hash()
```

To pin an algorithm or its cost parameters, construct `ScryptHasher` or `NodeHasher` directly — see [Algorithm Options](#algorithm-options).

### Hashing Passwords

```typescript
const hashedPassword = await hash.hash('user-password')
// Returns: $argon2id$v=19$m=65536,t=2,p=1$...
```

Models extending `AuthenticatableModel` do this for you: pass a plain `password` on `create()` and the model hashes it into the `passwordHash` column. See [Authentication](/docs/guides/authentication).

### Verifying Passwords

**The stored hash comes first.**

```typescript
const isValid = await hash.verify(hashedPassword, 'user-password')
```

That order is the inverse of `Bun.password.verify(plain, hashed)` and of the standalone `verifyPassword(plain, hashed)` helper, so it is worth checking at every call site. Both parameters are `string`, so a swapped call compiles and no type error points at it; the built-in hashers detect the obvious case at runtime and throw a `TypeError` naming the order.

Most apps never need to call this. If you have an `AuthManager` configured, a **session** guard does the lookup and the comparison together, including the dummy hash that keeps a missing account from being distinguishable by response time:

```typescript
const user = await this.auth.guard('web').validate({ email, password })
if (!user) {
  return this.json({ error: 'Invalid credentials' }, { status: 401 })
}
```

Name the guard. `TokenGuard.validate()` throws — bearer tokens are not credential-based — so a token-only API issuing a token from an email and password has to reach a session guard, or a `ModelUserProvider`, explicitly.

### Checking If Rehash Needed

```typescript
if (hash.needsRehash(user.passwordHash)) {
  await user.update({ password: plainPassword })
}
```

`needsRehash()` compares the parameters encoded in the hash against the ones the hasher is configured with, so it reports `true` after you raise a cost factor. Nothing in the framework calls it for you.

## Algorithm Options

### Argon2 (Bun default)

```typescript
const hash = new ScryptHasher({
  algorithm: 'argon2id', // 'argon2i', 'argon2d', or 'argon2id' (default)
  memoryCost: 65536,     // Memory usage in KiB
  timeCost: 3,           // Iterations
})
```

### Bcrypt

```typescript
const hash = new ScryptHasher({
  algorithm: 'bcrypt',
  cost: 12, // Log rounds
})
```

### Scrypt (Node)

```typescript
const hash = new NodeHasher({
  cost: 16384,     // CPU/memory cost (N)
  memory: 8,       // Block size (r)
  saltLength: 16,  // Salt bytes
  keyLength: 64,   // Output bytes
})
```

The same scrypt implementation is available as standalone functions, which take the **plaintext first** — the opposite of `PasswordHasher.verify()`:

```typescript
import { hashPassword, verifyPassword, needsRehash } from '@guren/core'

const stored = await hashPassword('user-password')
const ok = await verifyPassword('user-password', stored)
```

## Using in Controllers

```typescript
import { Controller, Hash } from '@guren/core'

export default class AuthController extends Controller {
  private hash = new Hash()

  async register() {
    const { email, password } = await this.validateBody(RegisterSchema)

    // AuthenticatableModel hashes `password` into `passwordHash` for you.
    const user = await User.create({ email, password })

    return this.json({ user })
  }

  async login() {
    const { email, password } = await this.validateBody(LoginSchema)
    const user = await User.first({ email })

    // Stored hash first. `verify(password, user.passwordHash)` type-checks
    // and is wrong.
    if (!user || !(await this.hash.verify(user.passwordHash, password))) {
      return this.json({ error: 'Invalid credentials' }, { status: 401 })
    }

    if (this.hash.needsRehash(user.passwordHash)) {
      await user.update({ password })
    }

    return this.json({ user })
  }
}
```

## Security Best Practices

1. **Never store plain passwords** — Always hash passwords before storing.
2. **Use a strong APP_KEY** — Run `bunx guren key:generate --write` to generate one. Never commit it to version control.
3. **Don't roll your own crypto** — Use the provided utilities.
4. **Rotate keys periodically** — Use `APP_PREVIOUS_KEYS` to rotate without downtime (see [Key Rotation](#key-rotation)).
5. **Let `Hash` pick the algorithm** — it is Argon2id on Bun and scrypt on Node, and it is the only hasher that runs on both.

## Testing

```typescript
import { describe, it, expect } from 'bun:test'
import { Encrypter, Hash, generateKey } from '@guren/core'

describe('Encryption', () => {
  it('encrypts and decrypts data', () => {
    const encrypter = new Encrypter({ key: generateKey() })

    const encrypted = encrypter.encrypt('secret')
    const decrypted = encrypter.decrypt(encrypted)

    expect(decrypted).toBe('secret')
  })
})

describe('Hashing', () => {
  it('hashes and verifies passwords', async () => {
    const hash = new Hash()

    const hashed = await hash.hash('password123')
    const valid = await hash.verify(hashed, 'password123')

    expect(valid).toBe(true)
  })

  it('rejects invalid passwords', async () => {
    const hash = new Hash()

    const hashed = await hash.hash('password123')
    const valid = await hash.verify(hashed, 'wrong-password')

    expect(valid).toBe(false)
  })
})
```
