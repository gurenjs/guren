# 暗号化とハッシュ

Guren はデータの暗号化とパスワードの安全なハッシュ化のためのユーティリティを提供しています。

## APP_KEY

すべてのGurenアプリケーションには `APP_KEY` が必要です。これはbase64エンコードされた32バイトのシークレットで、暗号化、Cookie署名、トークン署名に使用されます。GurenはHKDFを使って各目的ごとに個別のキーを導出するため、単一の `APP_KEY` で全サブシステムを安全に保護できます。

### キーの生成

```bash
# キーを生成して表示
bunx guren key:generate

# キーを生成して .env に直接書き込み
bunx guren key:generate --write
```

`create-guren-app` でプロジェクトをスキャフォールドすると、`APP_KEY` は自動的に生成されます。

### キーローテーション

既存の暗号化データやアクティブなセッションを壊さずに `APP_KEY` をローテーションするには:

1. 現在の `APP_KEY` の値を `APP_PREVIOUS_KEYS` に移動
2. 新しい `APP_KEY` を生成

```bash
# .env
APP_KEY=base64:<新しいキー>
APP_PREVIOUS_KEYS=base64:<古いキー>
```

複数の旧キーはカンマ区切りで指定できます。Gurenは現在のキーを最初に試し、復号や署名検証時に旧キーへフォールバックします。

## 暗号化

`Encrypter`クラスは機密データのAES-256-GCM暗号化を提供します。

### セットアップ

32バイトのキーでEncrypterを作成します。

```typescript
import { Encrypter, generateKey } from '@guren/core'

// 新しいキーを生成
const key = generateKey()
console.log(key) // base64:... (32バイトのキー)

// Encrypterを作成
const encrypter = new Encrypter({ key })

// キーローテーション対応
const rotatedEncrypter = new Encrypter({
  key: newKey,
  previousKeys: [oldKey],
})
```

### データの暗号化

```typescript
// 任意の値を暗号化（オブジェクトは自動的にJSONシリアライズされます）
const encrypted = encrypter.encrypt({ userId: 1, token: 'abc123' })

// シリアライズなしで文字列を暗号化
const encryptedString = encrypter.encryptString('secret message')
```

### データの復号化

```typescript
// 復号化（JSONは自動的にデシリアライズされます）
const data = encrypter.decrypt(encrypted)
// 戻り値: { userId: 1, token: 'abc123' }

// 文字列を復号化
const message = encrypter.decryptString(encryptedString)
// 戻り値: 'secret message'
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
import { Encrypter } from '@guren/core'

try {
  const decrypted = encrypter.decrypt(invalidPayload)
} catch (error) {
  console.error('復号化に失敗しました:', (error as Error).message)
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

1. **平文パスワードを保存しない** — パスワードは保存前に必ずハッシュ化します。
2. **強力なAPP_KEYを使用** — `bunx guren key:generate --write` で生成します。バージョン管理にコミットしないでください。
3. **独自の暗号化を作らない** — 提供されているユーティリティを使用します。
4. **定期的にキーをローテーション** — ダウンタイムなしでローテーションするには `APP_PREVIOUS_KEYS` を使用します（[キーローテーション](#キーローテーション)を参照）。
5. **新規プロジェクトにはScryptを使用** — Gurenのデフォルトかつ推奨のパスワードハッシュアルゴリズムです。

## テスト

```typescript
import { describe, it, expect } from 'bun:test'
import { Encrypter, Hash, generateKey } from '@guren/core'

describe('暗号化', () => {
  it('データを暗号化して復号化する', () => {
    const encrypter = new Encrypter({ key: generateKey() })

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
