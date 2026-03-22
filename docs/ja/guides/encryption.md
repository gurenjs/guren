# 暗号化とハッシュ

Guren はデータの暗号化とパスワードの安全なハッシュ化のためのユーティリティを提供しています。

## 暗号化

`Encrypter`クラスは機密データのAES-256-GCM暗号化を提供します。

### セットアップ

32バイトのキーでEncrypterを作成します。

```typescript
import { Encrypter, generateKey } from '@guren/core'

// 新しいキーを生成
const key = generateKey()
console.log(key) // Base64エンコードされた32バイトのキー

// Encrypterを作成
const encrypter = new Encrypter(key)
```

### データの暗号化

```typescript
// 文字列を暗号化
const encrypted = encrypter.encrypt('secret message')

// JSONシリアライズで暗号化（オブジェクト用）
const data = { userId: 1, token: 'abc123' }
const encryptedData = encrypter.encrypt(data, true)
```

### データの復号化

```typescript
// 文字列を復号化
const decrypted = encrypter.decrypt(encrypted)
// 戻り値: 'secret message'

// JSONデシリアライズで復号化
const decryptedData = encrypter.decrypt(encryptedData, true)
// 戻り値: { userId: 1, token: 'abc123' }
```

### キー管理

```typescript
import { generateKey, Encrypter } from '@guren/core'

// 暗号学的に安全なキーを生成
const key = generateKey()

// 現在のキーを取得
const currentKey = encrypter.getKey()
```

暗号化キーは環境変数に安全に保存してください。

```bash
# .env
APP_KEY=base64:your-32-byte-key-here
```

### エラーハンドリング

```typescript
import { Encrypter, DecryptException } from '@guren/core'

try {
  const decrypted = encrypter.decrypt(invalidPayload)
} catch (error) {
  if (error instanceof DecryptException) {
    console.error('復号化に失敗しました:', error.message)
  }
}
```

## ハッシュ化

`Hash`クラスはbcrypt、argon2、またはscryptアルゴリズムを使用した安全なパスワードハッシュを提供します。

### ハッシャーの作成

```typescript
import { Hash } from '@guren/core'

// デフォルトのbcryptハッシャー
const hash = new Hash()

// Argon2ハッシャー
const argon2Hash = new Hash({ driver: 'argon2' })

// Scryptハッシャー
const scryptHash = new Hash({ driver: 'scrypt' })

// カスタムラウンドのBcrypt
const bcryptHash = new Hash({ driver: 'bcrypt', rounds: 12 })
```

### パスワードのハッシュ化

```typescript
const hash = new Hash()

// パスワードをハッシュ化
const hashedPassword = await hash.make('user-password')
// 戻り値: $2b$10$...

// セキュリティのため非同期（ワーカースレッドを使用）
```

### パスワードの検証

```typescript
// パスワードが一致するかチェック
const isValid = await hash.check('user-password', hashedPassword)
// 戻り値: true または false
```

### 再ハッシュが必要かチェック

```typescript
// ハッシュを再ハッシュする必要があるかチェック（例：ラウンドが変更された場合）
const needsRehash = hash.needsRehash(hashedPassword)

if (needsRehash) {
  const newHash = await hash.make(plainPassword)
  await user.update({ password: newHash })
}
```

### ハッシュ情報の取得

```typescript
const info = hash.info(hashedPassword)
// 戻り値: { algorithm: 'bcrypt', options: { rounds: 10 } }
```

## アルゴリズムオプション

### Bcrypt（デフォルト）

```typescript
const hash = new Hash({
  driver: 'bcrypt',
  rounds: 10, // コストファクター（デフォルト: 10、推奨: 10-12）
})
```

### Argon2

```typescript
const hash = new Hash({
  driver: 'argon2',
  memoryCost: 65536,  // KB単位のメモリ使用量（デフォルト: 65536）
  timeCost: 3,        // イテレーション（デフォルト: 3）
  parallelism: 4,     // 並列スレッド（デフォルト: 4）
  type: 'argon2id',   // 'argon2i', 'argon2d', または 'argon2id'（デフォルト）
})
```

### Scrypt

```typescript
const hash = new Hash({
  driver: 'scrypt',
  cost: 16384,      // CPU/メモリコスト（N）
  blockSize: 8,     // ブロックサイズ（r）
  parallelization: 1, // 並列化（p）
  keyLength: 64,    // 出力長
})
```

## コントローラーでの使用

```typescript
import { Controller, Hash } from '@guren/core'

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
      return this.json({ error: '認証情報が無効です' }, 401)
    }

    // 再ハッシュが必要かチェック
    if (this.hash.needsRehash(user.password)) {
      await user.update({
        password: await this.hash.make(password),
      })
    }

    return this.json({ user })
  }
}
```

## セキュリティベストプラクティス

1. **平文パスワードを保存しない** - パスワードは保存前に必ずハッシュ化します。
2. **強力なAPP_KEYを使用** - 暗号化用にランダムな32バイトのキーを生成します。
3. **独自の暗号化を作らない** - 提供されているユーティリティを使用します。
4. **定期的にキーをローテーション** - 本番環境ではキーのローテーションを計画します。
5. **新規プロジェクトにはArgon2を使用** - パスワードハッシュの現在の推奨事項です。

## テスト

```typescript
import { describe, it, expect } from 'bun:test'
import { Encrypter, Hash, generateKey } from '@guren/core'

describe('暗号化', () => {
  it('データを暗号化して復号化する', () => {
    const encrypter = new Encrypter(generateKey())

    const encrypted = encrypter.encrypt('secret')
    const decrypted = encrypter.decrypt(encrypted)

    expect(decrypted).toBe('secret')
  })
})

describe('ハッシュ化', () => {
  it('パスワードをハッシュ化して検証する', async () => {
    const hash = new Hash()

    const hashed = await hash.make('password123')
    const valid = await hash.check('password123', hashed)

    expect(valid).toBe(true)
  })

  it('無効なパスワードを拒否する', async () => {
    const hash = new Hash()

    const hashed = await hash.make('password123')
    const valid = await hash.check('wrong-password', hashed)

    expect(valid).toBe(false)
  })
})
```
