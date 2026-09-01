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

パスワードのハッシュ化は`PasswordHasher`を通して行います。実装は3つ同梱されています。

| クラス | アルゴリズム | ランタイム |
| --- | --- | --- |
| `Hash`（`DefaultHasher`のエイリアス） | Bunでは`ScryptHasher`、それ以外では`NodeHasher`に委譲 | 両方 |
| `ScryptHasher` | `Bun.password`。既定はArgon2id、指定でbcrypt | Bunのみ |
| `NodeHasher` | `crypto.scrypt` | すべて |

特別な理由がなければ`Hash`を使ってください。BunでもAWS LambdaのようなNodeランタイムでも動く唯一の実装で、`AuthenticatableModel`と`ModelUserProvider`の既定値でもあります。

> `ScryptHasher`が生成するのはscryptではなくArgon2idです。名前が実装より古いだけで、scryptを使うのは`NodeHasher`だけです。

2つのランタイムはハッシュ形式が異なるため、一方で書いたハッシュをもう一方で検証することはできません。既存のパスワードカラムをランタイム間で移す場合にだけ問題になります。

### ハッシャーの作成

```typescript
import { Hash } from '@guren/core'

// ランタイムを自動判定する。オプションは取らない
const hash = new Hash()
```

アルゴリズムやコストパラメータを固定したい場合は `ScryptHasher` / `NodeHasher` を直接構築してください。[アルゴリズムオプション](#アルゴリズムオプション)を参照。

### パスワードのハッシュ化

```typescript
const hashedPassword = await hash.hash('user-password')
// 戻り値: $argon2id$v=19$m=65536,t=2,p=1$...
```

`AuthenticatableModel`を継承したモデルはこれを自動で行います。`create()`に平文の`password`を渡すと、モデルが`passwordHash`カラムへハッシュ化して格納します。[認証](/docs/guides/authentication)を参照してください。

### パスワードの検証

**保存済みのハッシュが第1引数です。**

```typescript
const isValid = await hash.verify(hashedPassword, 'user-password')
```

この順序は`Bun.password.verify(plain, hashed)`および単体関数の`verifyPassword(plain, hashed)`とは逆なので、呼び出しごとに確認する価値があります。どちらの引数も`string`なので入れ替えてもコンパイルは通り、型エラーは出ません。同梱のハッシャーは明らかな入れ替えを実行時に検出し、順序を明示した`TypeError`をスローします。

多くのアプリではこれを直接呼ぶ必要はありません。`AuthManager`を設定していれば、**セッション**ガードが検索と照合をまとめて行います。アカウントが存在しない場合にダミーハッシュを走らせる処理も含まれるので、応答時間からアカウントの有無を判別されずに済みます。

```typescript
const user = await this.auth.guard('web').validate({ email, password })
if (!user) {
  return this.json({ error: 'Invalid credentials' }, { status: 401 })
}
```

ガード名は明示してください。`TokenGuard.validate()` はスローします（ベアラートークンは資格情報ベースではないため）。メールとパスワードからトークンを発行するトークン専用 API は、セッションガードか `ModelUserProvider` を明示的に取得する必要があります。

### 再ハッシュが必要かチェック

```typescript
if (hash.needsRehash(user.passwordHash)) {
  await user.update({ password: plainPassword })
}
```

`needsRehash()`はハッシュに埋め込まれたパラメータとハッシャーの設定値を比較するので、コストファクタを上げた後に`true`を返します。フレームワークが自動で呼ぶことはありません。

## アルゴリズムオプション

### Argon2（Bunの既定）

```typescript
const hash = new ScryptHasher({
  algorithm: 'argon2id', // 'argon2i'、'argon2d'、'argon2id'（既定）
  memoryCost: 65536,     // メモリ使用量（KiB）
  timeCost: 3,           // 反復回数
})
```

### Bcrypt

```typescript
const hash = new ScryptHasher({
  algorithm: 'bcrypt',
  cost: 12, // ログラウンド数
})
```

### Scrypt（Node）

```typescript
const hash = new NodeHasher({
  cost: 16384,     // CPU/メモリコスト（N）
  memory: 8,       // ブロックサイズ（r）
  saltLength: 16,  // ソルトのバイト数
  keyLength: 64,   // 出力のバイト数
})
```

同じscrypt実装は単体関数としても使えます。こちらは**平文が第1引数**で、`PasswordHasher.verify()`とは逆です。

```typescript
import { hashPassword, verifyPassword, needsRehash } from '@guren/core'

const stored = await hashPassword('user-password')
const ok = await verifyPassword('user-password', stored)
```

## コントローラーでの使用

```typescript
import { Controller, Hash } from '@guren/core'

export default class AuthController extends Controller {
  private hash = new Hash()

  async register() {
    const { email, password } = await this.validateBody(RegisterSchema)

    // AuthenticatableModel が password を passwordHash へハッシュ化する
    const user = await User.create({ email, password })

    return this.json({ user })
  }

  async login() {
    const { email, password } = await this.validateBody(LoginSchema)
    const user = await User.first({ email })

    // 保存済みのハッシュが第1引数。verify(password, user.passwordHash) は
    // 型としては通るが誤り
    if (!user || !(await this.hash.verify(user.passwordHash, password))) {
      return this.json({ error: '認証情報が無効です' }, { status: 401 })
    }

    if (this.hash.needsRehash(user.passwordHash)) {
      await user.update({ password })
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
5. **アルゴリズムの選択は`Hash`に任せる**: BunではArgon2id、Nodeではscryptになります。両方で動く唯一のハッシャーです。

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

    const hashed = await hash.hash('password123')
    const valid = await hash.verify(hashed, 'password123')

    expect(valid).toBe(true)
  })

  it('無効なパスワードを拒否する', async () => {
    const hash = new Hash()

    const hashed = await hash.hash('password123')
    const valid = await hash.verify(hashed, 'wrong-password')

    expect(valid).toBe(false)
  })
})
```
