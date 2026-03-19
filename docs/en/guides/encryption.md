# Encryption & Hashing

Guren provides utilities for encrypting data and hashing passwords securely.

## Encryption

The `Encrypter` class provides AES-256-GCM encryption for sensitive data.

### Setup

Create an encrypter with a 32-byte key:

```typescript
import { Encrypter, generateKey } from '@guren/server'

// Generate a new key
const key = generateKey()
console.log(key) // Base64-encoded 32-byte key

// Create encrypter
const encrypter = new Encrypter(key)
```

### Encrypting Data

```typescript
// Encrypt a string
const encrypted = encrypter.encrypt('secret message')

// Encrypt with JSON serialization (for objects)
const data = { userId: 1, token: 'abc123' }
const encryptedData = encrypter.encrypt(data, true)
```

### Decrypting Data

```typescript
// Decrypt a string
const decrypted = encrypter.decrypt(encrypted)
// Returns: 'secret message'

// Decrypt with JSON deserialization
const decryptedData = encrypter.decrypt(encryptedData, true)
// Returns: { userId: 1, token: 'abc123' }
```

### Key Management

```typescript
import { generateKey, Encrypter } from '@guren/server'

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
import { Encrypter, DecryptException } from '@guren/server'

try {
  const decrypted = encrypter.decrypt(invalidPayload)
} catch (error) {
  if (error instanceof DecryptException) {
    console.error('Decryption failed:', error.message)
  }
}
```

## Hashing

The `Hash` class provides secure password hashing using bcrypt, argon2, or scrypt algorithms.

### Creating a Hasher

```typescript
import { Hash } from '@guren/server'

// Default bcrypt hasher
const hash = new Hash()

// Argon2 hasher
const argon2Hash = new Hash({ driver: 'argon2' })

// Scrypt hasher
const scryptHash = new Hash({ driver: 'scrypt' })

// Bcrypt with custom rounds
const bcryptHash = new Hash({ driver: 'bcrypt', rounds: 12 })
```

### Hashing Passwords

```typescript
const hash = new Hash()

// Hash a password
const hashedPassword = await hash.make('user-password')
// Returns: $2b$10$...

// Hash is async for security (uses worker threads)
```

### Verifying Passwords

```typescript
// Check if a password matches
const isValid = await hash.check('user-password', hashedPassword)
// Returns: true or false
```

### Checking If Rehash Needed

```typescript
// Check if hash needs to be rehashed (e.g., rounds changed)
const needsRehash = hash.needsRehash(hashedPassword)

if (needsRehash) {
  const newHash = await hash.make(plainPassword)
  await user.update({ password: newHash })
}
```

### Getting Hash Info

```typescript
const info = hash.info(hashedPassword)
// Returns: { algorithm: 'bcrypt', options: { rounds: 10 } }
```

## Algorithm Options

### Bcrypt (Default)

```typescript
const hash = new Hash({
  driver: 'bcrypt',
  rounds: 10, // Cost factor (default: 10, recommended: 10-12)
})
```

### Argon2

```typescript
const hash = new Hash({
  driver: 'argon2',
  memoryCost: 65536,  // Memory usage in KB (default: 65536)
  timeCost: 3,        // Iterations (default: 3)
  parallelism: 4,     // Parallel threads (default: 4)
  type: 'argon2id',   // 'argon2i', 'argon2d', or 'argon2id' (default)
})
```

### Scrypt

```typescript
const hash = new Hash({
  driver: 'scrypt',
  cost: 16384,      // CPU/memory cost (N)
  blockSize: 8,     // Block size (r)
  parallelization: 1, // Parallelization (p)
  keyLength: 64,    // Output length
})
```

## Using in Controllers

```typescript
import { Controller, Hash } from '@guren/server'

export default class AuthController extends Controller {
  private hash = new Hash()

  async register() {
    const { email, password } = await this.request.json()

    const user = await User.create({
      email,
      password: await this.hash.make(password),
    })

    return this.json({ user })
  }

  async login() {
    const { email, password } = await this.request.json()
    const user = await User.findBy('email', email)

    if (!user || !await this.hash.check(password, user.password)) {
      return this.json({ error: 'Invalid credentials' }, 401)
    }

    // Check if rehash needed
    if (this.hash.needsRehash(user.password)) {
      await user.update({
        password: await this.hash.make(password),
      })
    }

    return this.json({ user })
  }
}
```

## Security Best Practices

1. **Never store plain passwords** - Always hash passwords before storing.
2. **Use a strong APP_KEY** - Generate a random 32-byte key for encryption.
3. **Don't roll your own crypto** - Use the provided utilities.
4. **Rotate keys periodically** - Plan for key rotation in production.
5. **Use Argon2 for new projects** - It's the current recommendation for password hashing.

## Testing

```typescript
import { describe, it, expect } from 'bun:test'
import { Encrypter, Hash, generateKey } from '@guren/server'

describe('Encryption', () => {
  it('encrypts and decrypts data', () => {
    const encrypter = new Encrypter(generateKey())

    const encrypted = encrypter.encrypt('secret')
    const decrypted = encrypter.decrypt(encrypted)

    expect(decrypted).toBe('secret')
  })
})

describe('Hashing', () => {
  it('hashes and verifies passwords', async () => {
    const hash = new Hash()

    const hashed = await hash.make('password123')
    const valid = await hash.check('password123', hashed)

    expect(valid).toBe(true)
  })

  it('rejects invalid passwords', async () => {
    const hash = new Hash()

    const hashed = await hash.make('password123')
    const valid = await hash.check('wrong-password', hashed)

    expect(valid).toBe(false)
  })
})
```
