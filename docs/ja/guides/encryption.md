# 暗号化とハッシュ

Guren には、データの暗号化とパスワードの安全なハッシュ化を行うためのユーティリティが用意されています。

## APP_KEY

Guren アプリケーションには必ず `APP_KEY` が要ります。base64 エンコードされた 32 バイトのシークレットで、暗号化と Cookie 署名、トークン署名に使われます。用途ごとのキーは HKDF で個別に導出されるので、`APP_KEY` ひとつで全サブシステムを安全に保護できます。

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

旧キーが複数ある場合はカンマ区切りで指定します。Guren は現在のキーを最初に試し、復号や署名検証では旧キーにもフォールバックします。

## 暗号化

`Encrypter` クラスは、機密データを AES-256-GCM で暗号化します。

### セットアップ

32 バイトのキーを渡して Encrypter を作成します。

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

パスワードのハッシュ化は `PasswordHasher` を通して行います。実装は 3 つ同梱されています。

| クラス | アルゴリズム | ランタイム |
| --- | --- | --- |
| `Hash`（`DefaultHasher` のエイリアス） | scrypt を書く（`algorithm: 'argon2'` なら Argon2id）。検証は保存されたハッシュの形式に従う | 両方 |
| `Argon2Hasher` | `Bun.password`。既定は Argon2id、指定で bcrypt | Bun のみ |
| `NodeHasher` | `crypto.scrypt` | すべて |

特別な理由がなければ `Hash` を使ってください。`AuthenticatableModel` と `ModelUserProvider` の既定値であり、両方の形式を検証できる唯一の実装です。`NodeHasher` も両方で動きます。Bun が `node:crypto` を実装しているためです。Bun 専用なのは `Argon2Hasher` だけです。アプリケーションでは直接構築せず、`createApp({ auth: { hasher } })` で 1 回だけ選びます（[認証](/docs/guides/authentication#パスワードハッシャー)を参照）。

> `Argon2Hasher` は 2.23.0 まで `ScryptHasher` という名前でした。書き出すのは scrypt ではないので改名しています。旧名も同じクラスを指しますが、非推奨です。

2 つの形式に互換性はありません。`$scrypt$` のハッシュはどこでも検証できますが、Argon2id は `Bun.password` のある環境でしか検証できません。`Hash` が scrypt を書くのはそのためで、別形式のハッシュは `needsRehash()` で報告します。

### ハッシャーの作成

```typescript
import { Hash } from '@guren/core'

// scrypt を書く。検証は保存されたプレフィックスに従い、scrypt・Argon2id・bcrypt を受け付ける
const hash = new Hash()

// Bun.password で Argon2id を書く。Bun.password のないランタイムでは例外になる
const argon2 = new Hash({ algorithm: 'argon2' })
```

アルゴリズムやコストパラメータを固定したい場合は `Argon2Hasher` / `NodeHasher` を直接構築してください。[アルゴリズムオプション](#アルゴリズムオプション)を参照。

### パスワードのハッシュ化

```typescript
const hashedPassword = await hash.hash('user-password')
// $scrypt$N=16384,r=8,p=1$...
```

`AuthenticatableModel` を継承したモデルは、これを自動で行います。`create()` に平文の `password` を渡すと、モデルがハッシュ化して `passwordHash` カラムへ格納します。[認証](/docs/guides/authentication)を参照してください。

### パスワードの検証

**保存済みのハッシュが第1引数です。**

```typescript
const isValid = await hash.verify(hashedPassword, 'user-password')
```

この順序は `Bun.password.verify(plain, hashed)` や単体関数の `verifyPassword(plain, hashed)` とは逆なので、呼び出すたびに確認してください。どちらの引数も `string` なので、入れ替えてもコンパイルは通り、型エラーは出ません。同梱のハッシャーは明らかな入れ替えを実行時に検出し、順序を明示した `TypeError` をスローします。

多くのアプリではこれを直接呼ぶ必要はありません。`AuthManager` を設定していれば、**セッション**ガードが検索と照合をまとめて行います。アカウントが存在しない場合にダミーハッシュを走らせる処理も含まれるので、応答時間からアカウントの有無を判別されずに済みます。

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
  await User.update({ id: user.id }, { password: plainPassword })
}
```

`needsRehash()` はハッシュに埋め込まれたパラメータとハッシャーの設定値を比較するので、コストファクタを上げたあとに `true` を返します。`Hash` は自分が書かない形式のハッシュにも `true` を返します。セッションガードはログイン成功のたびにこれを呼び、必要ならその場でパスワードを再ハッシュします。

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

同じ scrypt 実装は単体関数としても使えます。こちらは**平文が第1引数**で、`PasswordHasher.verify()` とは逆です。

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

1. **平文パスワードを保存しない**: パスワードは保存前に必ずハッシュ化します。
2. **強度のある APP_KEY を使う**: `bunx guren key:generate --write` で生成します。バージョン管理にはコミットしないでください。
3. **独自の暗号化を作らない**: 用意されているユーティリティを使います。
4. **キーを定期的にローテーションする**: ダウンタイムなしで入れ替えるには `APP_PREVIOUS_KEYS` を使います（[キーローテーション](#キーローテーション)を参照）。
5. **形式の選択は `Hash` に任せる**: どこでも scrypt なので、ローカルの Bun で書いたカラムがデプロイ先でもそのまま検証できます。

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
