# 暗号化とハッシュ

Guren には、データを暗号化するユーティリティと、パスワードを安全にハッシュ化するユーティリティが入っています。

## APP_KEY

Guren アプリケーションには必ず `APP_KEY` を設定します。base64 でエンコードした 32 バイトのシークレットで、暗号化、Cookie の署名、トークンの署名に使います。用途ごとのキーは HKDF でそれぞれ導出するので、`APP_KEY` が 1 つあればすべてのサブシステムを安全に保護できます。

### キーの生成

```bash
# キーを生成して表示
bunx guren key:generate

# キーを生成して .env に直接書き込み
bunx guren key:generate --write
```

`create-guren-app` でプロジェクトの雛形を作ると、`APP_KEY` も自動で生成されます。

### キーローテーション

暗号化済みのデータや有効なセッションを壊さずに `APP_KEY` をローテーションするには、次の手順を踏みます。

1. 現在の `APP_KEY` の値を `APP_PREVIOUS_KEYS` に移す
2. 新しい `APP_KEY` を生成する

```bash
# .env
APP_KEY=base64:<新しいキー>
APP_PREVIOUS_KEYS=base64:<古いキー>
```

古いキーが複数あるときはカンマで区切って並べます。Guren はまず現在のキーを使い、復号や署名の検証に失敗したら古いキーでも試します。

## 暗号化

機密データの暗号化には `Encrypter` クラスを使います。暗号方式は AES-256-GCM です。

### セットアップ

32 バイトのキーを渡して Encrypter を作ります。

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

暗号化キーは環境変数に入れ、安全に管理してください。

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

パスワードのハッシュ化には `PasswordHasher` を使います。実装は次の 3 つが同梱されています。

| クラス | アルゴリズム | ランタイム |
| --- | --- | --- |
| `Hash`（`DefaultHasher` のエイリアス） | scrypt で書き込む（`algorithm: 'argon2'` なら Argon2id）。検証は保存済みハッシュの形式に合わせる | 両方 |
| `Argon2Hasher` | `Bun.password`。既定は Argon2id で、指定すれば bcrypt | Bun のみ |
| `NodeHasher` | `crypto.scrypt` | すべて |

特別な理由がなければ `Hash` を使ってください。`AuthenticatableModel` と `ModelUserProvider` が既定で使うハッシャーで、両方の形式を検証できるのはこれだけです。Bun は `node:crypto` を実装しているので、`NodeHasher` もどちらのランタイムでも動きます。Bun 専用は `Argon2Hasher` だけです。アプリケーションではハッシャーを直接構築せず、`createApp({ auth: { hasher } })` で 1 回だけ選びます（[認証](/docs/guides/authentication#パスワードハッシャー)を参照）。

> `Argon2Hasher` は 2.23.0 まで `ScryptHasher` という名前でした。実際に書き込む形式は scrypt ではないため、名前を変えています。旧名も同じクラスを指しますが、非推奨です。

2 つの形式には互換性がありません。`$scrypt$` のハッシュはどの環境でも検証できますが、Argon2id のハッシュは `Bun.password` がある環境でしか検証できません。そのため `Hash` は scrypt で書き込み、もう一方の形式のハッシュを見つけると `needsRehash()` で知らせます。

### ハッシャーの作成

```typescript
import { Hash } from '@guren/core'

// scrypt を書く。検証は保存されたプレフィックスに従い、scrypt・Argon2id・bcrypt を受け付ける
const hash = new Hash()

// Bun.password で Argon2id を書く。Bun.password のないランタイムでは例外になる
const argon2 = new Hash({ algorithm: 'argon2' })
```

アルゴリズムやコストパラメータを固定したい場合は、`Argon2Hasher` / `NodeHasher` を直接構築してください。詳しくは[アルゴリズムオプション](#アルゴリズムオプション)を参照してください。

### パスワードのハッシュ化

```typescript
const hashedPassword = await hash.hash('user-password')
// $scrypt$N=16384,r=8,p=1$...
```

`AuthenticatableModel` を継承したモデルでは、この処理が自動で行われます。`create()` に平文の `password` を渡すと、モデルがハッシュ化して `passwordHash` カラムに保存します。詳しくは[認証](/docs/guides/authentication)を参照してください。

### パスワードの検証

**保存済みのハッシュが第1引数です。**

```typescript
const isValid = await hash.verify(hashedPassword, 'user-password')
```

この順序は `Bun.password.verify(plain, hashed)` や単体関数の `verifyPassword(plain, hashed)` と逆なので、呼び出すたびに確かめてください。引数はどちらも `string` のため、入れ替えてもコンパイルは通り、型エラーにはなりません。同梱のハッシャーは明らかな入れ替えを実行時に見つけ、正しい順序を示した `TypeError` を投げます。

たいていのアプリでは、これを直接呼ぶ必要はありません。`AuthManager` を設定していれば、**セッション**ガードがユーザーの検索と照合をまとめて行います。アカウントが存在しないときにもダミーのハッシュ計算を走らせるので、応答時間からアカウントの有無を見分けられることもありません。

```typescript
const user = await this.auth.guard('web').validate({ email, password })
if (!user) {
  return this.json({ error: 'Invalid credentials' }, { status: 401 })
}
```

ガード名は明示してください。ベアラートークンは資格情報で認証する仕組みではないので、`TokenGuard.validate()` は例外を投げます。トークンだけを使う API でメールアドレスとパスワードからトークンを発行するなら、セッションガードか `ModelUserProvider` を明示的に取得してください。

### 再ハッシュが必要かチェック

```typescript
if (hash.needsRehash(user.passwordHash)) {
  await User.update({ id: user.id }, { password: plainPassword })
}
```

`needsRehash()` は、ハッシュに埋め込まれたパラメータとハッシャーの設定値を比べます。そのため、コストファクタを上げたあとは `true` を返します。`Hash` の場合は、自分では書き込まない形式のハッシュに対しても `true` を返します。セッションガードはログインに成功するたびにこれを呼び、必要ならその場でパスワードを再ハッシュします。

## アルゴリズムオプション

### Argon2（Bun のみ）

```typescript
const hash = new Argon2Hasher({
  algorithm: 'argon2id', // 'argon2i'、'argon2d'、'argon2id'（既定）
  memoryCost: 65536,     // メモリ使用量（KiB）
  timeCost: 3,           // 反復回数
})
```

### Bcrypt

```typescript
const hash = new Argon2Hasher({
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

同じ scrypt の実装は単体の関数としても使えます。こちらは `PasswordHasher.verify()` とは逆に、**平文が第1引数**です。

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
      await User.update({ id: user.id }, { password })
    }

    return this.json({ user })
  }
}
```

## セキュリティベストプラクティス

1. **平文パスワードを保存しない**: パスワードは保存する前に必ずハッシュ化します。
2. **強度のある APP_KEY を使う**: `bunx guren key:generate --write` で生成し、バージョン管理にはコミットしないでください。
3. **独自の暗号化を作らない**: 用意されているユーティリティを使います。
4. **キーを定期的にローテーションする**: `APP_PREVIOUS_KEYS` を使えば、ダウンタイムなしで入れ替えられます（[キーローテーション](#キーローテーション)を参照）。
5. **形式の選択は `Hash` に任せる**: どの環境でも scrypt で書き込むので、ローカルの Bun で書いたカラムをデプロイ先でもそのまま検証できます。

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
