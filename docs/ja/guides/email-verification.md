# メール確認ガイド

Guren のメール確認機能は、トークンの生成、検証、有効期限をまとめて扱います。トークン自体は保存せずに署名し、ストアには中身の読めないトークン ID だけを渡します。

## コアコンセプト

- **EmailVerificationTokenStore**: メール確認トークンを保存するためのインターフェースです。
- **署名済みトークン**: トークンは `APP_KEY` から導出した鍵で署名され、有効期限をトークン自身が持ちます。
- **平文は保存しない**: 保存されるのは中身の読めないトークン ID だけで、トークン自体は保存しません。
- **有効期限の判断は 1 か所**: 検証時は、トークンに署名された有効期限を読みます。ストアに問い合わせるのは、そのトークン ID がまだ存在するかどうかだけです。
- **使えるのは 1 回だけ**: 確認に成功すると、トークンは削除されます。
- **有効期限**: トークンは設定した時間が過ぎると期限切れになります（デフォルトは 24 時間）。

## 基本的な使い方

### 確認トークンの作成

```ts
import { createEmailVerificationToken, MemoryEmailVerificationStore } from '@guren/core'

const store = new MemoryEmailVerificationStore() // 本番環境ではデータベースを使用

// 確認トークンを作成
const { token, expiresAt } = await createEmailVerificationToken(
  'user@example.com',
  store
)

// 確認メールを送信
await sendVerificationEmail(email, token)
```

### トークンの検証（読み取り専用）

```ts
import { verifyEmailToken } from '@guren/core'

// トークンを消費せずに有効性を確認
const email = await verifyEmailToken(token, store)

if (!email) {
  return ctx.json({ error: '無効または期限切れのトークン' }, 400)
}

// トークンは有効だが、まだ消費されていない
return ctx.json({ email, valid: true })
```

### 確認の完了

```ts
import { completeEmailVerification } from '@guren/core'

const user = await completeEmailVerification(
  token,
  store,
  async (email) => {
    // ユーザーのメールを確認済みとしてマーク
    await User.update(
      { email },
      { emailVerifiedAt: new Date() }
    )
    return User.findByEmail(email)
  }
)

if (!user) {
  return ctx.json({ error: '無効または期限切れのトークン' }, 400)
}

return ctx.redirect('/dashboard')
```

## 完全な実装例

### ルート

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

### コントローラー

```ts
import { Controller } from '@guren/core'
import {
  createEmailVerificationToken,
  completeEmailVerification,
  buildVerificationUrl,
  isEmailVerified,
} from '@guren/core'
import { User } from '@/app/Models/User'
import { pages } from '@/.guren/pages.gen'

export class VerificationController extends Controller {
  private store = new DatabaseEmailVerificationStore()

  async notice() {
    const user = await this.auth.user()

    if (isEmailVerified(user)) {
      return this.redirect('/dashboard')
    }

    return this.inertia(pages.auth.VerifyEmail, {
      email: user.email,
    })
  }

  async resend() {
    const user = await this.auth.user()

    if (isEmailVerified(user)) {
      return this.json({ message: 'すでにメール確認済みです' })
    }

    const { token } = await createEmailVerificationToken(
      user.email,
      this.store,
      { expiresIn: 24 * 60 * 60 * 1000 } // 24時間
    )

    const verifyUrl = buildVerificationUrl(
      `${process.env.APP_URL}/email/verify`,
      token
    )

    await this.sendVerificationEmail(user, verifyUrl)

    return this.json({ message: '確認メールを送信しました' })
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
      return this.inertia(pages.auth.VerifyEmail, {
        error: '無効または期限切れの確認リンク',
      })
    }

    return this.redirect('/dashboard?verified=1')
  }

  private async sendVerificationEmail(user: User, verifyUrl: string) {
    await mail.send({
      to: user.email,
      subject: 'メールアドレスを確認してください',
      html: `
        <h1>メール確認</h1>
        <p>以下のボタンをクリックしてメールアドレスを確認してください：</p>
        <a href="${verifyUrl}" style="...">メールを確認</a>
        <p>このリンクは24時間で期限切れになります。</p>
        <p>アカウントを作成した覚えがない場合は、何もする必要はありません。</p>
      `,
    })
  }
}
```

## ヘルパー関数

### メール確認状態のチェック

```ts
import { isEmailVerified } from '@guren/core'

// ユーザーのメールが確認済みかチェック
if (isEmailVerified(user)) {
  // ユーザーのメールは確認済み
}

// nullableなユーザーでも動作
if (!isEmailVerified(null)) {
  // nullの場合はfalseを返す
}
```

### メール確認必須ミドルウェア

```ts
import { AUTH_CONTEXT_KEY, Router, requireVerifiedEmail } from '@guren/core'
import type { AuthContext } from '@guren/core'

const router = new Router()

// メール未確認ユーザーをリダイレクト
router.get('/dashboard', [DashboardController, 'index']).middleware(
  requireVerifiedEmail({ redirectTo: '/email/verify' })
)

// 別のガードのユーザーを確認
router.get('/profile', [ProfileController, 'show']).middleware(
  requireVerifiedEmail({
    redirectTo: '/verify-email',
    getUser: async (ctx) => {
      const auth = ctx.get<AuthContext | undefined>(AUTH_CONTEXT_KEY)
      return (await auth?.guard('api').user<{ emailVerifiedAt: Date | null }>()) ?? null
    },
  })
)
```

`getUser` を省略した場合は、リクエストの認証コンテキストが解決したユーザーを確認します。`auth.registerGuard('api', factory)` で登録した `api` ガードなど、別の場所からユーザーを取得したいときは `getUser` を渡してください（[認証](./authentication.md)を参照）。

エージェントのツール呼び出し（[エージェントインターフェース](./agent-interface.md)を参照）はリダイレクトをたどれません。そのため、メール未確認のユーザーがツールを呼ぶと、リダイレクトの代わりに `403` と `{ "message": "Email address is not verified" }` が返ります。

## URLヘルパー

### 確認URLの構築

```ts
import { buildVerificationUrl } from '@guren/core'

// トークン付きの基本URL
const url = buildVerificationUrl('https://example.com/verify', token)
// 結果: https://example.com/verify?token=abc123...

// メールパラメータ付き
const urlWithEmail = buildVerificationUrl(
  'https://example.com/verify',
  token,
  'user@example.com'
)
// 結果: https://example.com/verify?token=abc123...&email=user%40example.com
```

### 確認URLの解析

```ts
import { parseVerificationUrl } from '@guren/core'

const { token, email } = parseVerificationUrl(
  'https://example.com/verify?token=abc123&email=user%40example.com'
)

console.log(token) // 'abc123'
console.log(email) // 'user@example.com'
```

## データベースストレージ

### EmailVerificationTokenStoreの実装

```ts
import type { EmailVerificationTokenStore, EmailVerificationToken } from '@guren/core'
import { emailVerifications } from '@/db/schema'
import { eq } from 'drizzle-orm'

export class DatabaseEmailVerificationStore implements EmailVerificationTokenStore {
  async store(token: EmailVerificationToken): Promise<void> {
    await db.insert(emailVerifications).values({
      tokenId: token.tokenId,
      email: token.email,
      expiresAt: token.expiresAt,
      createdAt: token.createdAt,
    })
  }

  async findByTokenId(tokenId: string): Promise<EmailVerificationToken | null> {
    const result = await db.select()
      .from(emailVerifications)
      .where(eq(emailVerifications.tokenId, tokenId))
      .limit(1)

    if (!result[0]) return null

    return {
      email: result[0].email,
      tokenId: result[0].tokenId,
      expiresAt: result[0].expiresAt,
      createdAt: result[0].createdAt,
    }
  }

  async delete(tokenId: string): Promise<void> {
    await db.delete(emailVerifications)
      .where(eq(emailVerifications.tokenId, tokenId))
  }

  async deleteForEmail(email: string): Promise<void> {
    await db.delete(emailVerifications)
      .where(eq(emailVerifications.email, email.toLowerCase()))
  }
}
```

### データベーススキーマ

```ts
// db/schema.ts
import { pgTable, text, timestamp } from '@guren/orm/drizzle/pg'

export const emailVerifications = pgTable('email_verifications', {
  tokenId: text('token_id').primaryKey(),
  email: text('email').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

// usersテーブルにはemailVerifiedAtを含める
export const users = pgTable('users', {
  id: serial('id').primaryKey(),
  email: text('email').notNull().unique(),
  emailVerifiedAt: timestamp('email_verified_at', { withTimezone: true }),
  // ... その他のフィールド
})
```

物理カラム名は自由に決めて構いません。決まっているのは、ストアのメソッドのシグネチャだけです。このガイドでも以前は、ストアがトークンのハッシュを保持していた頃の `hashed_token` という名前を使っていました。すでにそのカラムがある場合は、移行せずにそのまま `tokenId` に対応付けてください。

## 設定

### トークンオプション

```ts
interface EmailVerificationConfig {
  /** トークン有効期限（ミリ秒、デフォルト: 24時間） */
  expiresIn?: number
  /** hex エンコード前のトークンバイト長（デフォルト: 32） */
  tokenLength?: number
}

// カスタム設定の例
const { token } = await createEmailVerificationToken(email, store, {
  expiresIn: 48 * 60 * 60 * 1000, // 48時間
  tokenLength: 64,
})
```

設定はトークンを発行するときに適用されます。`createEmailVerificationToken` が有効期限をトークン自体に署名して埋め込むので、`verifyEmailToken` と `completeEmailVerification` は設定を受け取りません。検証時は有効期限をトークンの署名済みクレームから読み取り、ストアには「そのトークン ID がまだ存在するか」だけを問い合わせます。`expiresIn` を変えても、影響を受けるのはそれ以降に発行するトークンだけで、送信済みのリンクはそのままです。署名鍵は `APP_KEY` から導出されます。

## テスト

```ts
import { describe, test, expect, beforeEach } from 'bun:test'
import {
  createEmailVerificationToken,
  verifyEmailToken,
  completeEmailVerification,
  isEmailVerified,
  MemoryEmailVerificationStore,
} from '@guren/core'

describe('メール確認', () => {
  let store: MemoryEmailVerificationStore

  beforeEach(() => {
    store = new MemoryEmailVerificationStore()
  })

  test('トークンを作成し検証する', async () => {
    const { token } = await createEmailVerificationToken('user@example.com', store)

    const email = await verifyEmailToken(token, store)

    expect(email).toBe('user@example.com')
  })

  test('メールを小文字に正規化する', async () => {
    const { token } = await createEmailVerificationToken('User@Example.COM', store)

    const email = await verifyEmailToken(token, store)

    expect(email).toBe('user@example.com')
  })

  test('期限切れトークンを拒否する', async () => {
    const { token } = await createEmailVerificationToken('user@example.com', store, {
      expiresIn: -1000, // すでに期限切れ
    })

    const email = await verifyEmailToken(token, store)

    expect(email).toBeNull()
  })

  test('確認を完了しトークンを消費する', async () => {
    const { token } = await createEmailVerificationToken('user@example.com', store)

    const result = await completeEmailVerification(
      token,
      store,
      async (email) => ({ email, verified: true })
    )

    expect(result).toEqual({ email: 'user@example.com', verified: true })

    // トークンは消費されているはず
    const secondAttempt = await verifyEmailToken(token, store)
    expect(secondAttempt).toBeNull()
  })

  test('isEmailVerifiedヘルパーが正しく動作する', () => {
    expect(isEmailVerified({ emailVerifiedAt: new Date() })).toBe(true)
    expect(isEmailVerified({ emailVerifiedAt: null })).toBe(false)
    expect(isEmailVerified(null)).toBe(false)
  })
})
```

## 登録フローの例

```ts
// UserController.ts
const RegisterSchema = z.object({
  name: z.string().min(2),
  email: z.email(),
  password: z.string().min(8),
})

async register() {
  const { name, email, password } = await this.validateBody(RegisterSchema)

  // ユーザーを作成
  const user = await User.create({
    name,
    email,
    password: await Bun.password.hash(password),
    emailVerifiedAt: null,
  })

  // 確認トークンを作成
  const { token } = await createEmailVerificationToken(email, this.store)

  // 確認メールを送信
  const verifyUrl = buildVerificationUrl(
    `${process.env.APP_URL}/email/verify`,
    token
  )
  await this.sendVerificationEmail(user, verifyUrl)

  // ユーザーをログイン
  await this.auth.login(user)

  // メール確認通知ページへリダイレクト
  return this.redirect('/email/verify')
}
```

## ベストプラクティス

1. **有効期限は長めにする**: メール確認トークンは、24〜72 時間で期限切れにしても安全です。

2. **メールアドレスを正規化する**: 大文字と小文字の違いによる問題を防ぐため、メールアドレスは小文字で保存します。

3. **再送信できるようにする**: ユーザーが必要なときに、新しい確認メールを請求できるようにします。

4. **古いトークンを片付ける**: 新しいトークンを作ると、同じメールアドレスの古いトークンは自動で削除されます。

5. **ルートを保護する**: メール確認済みのユーザーだけに見せるルートには、`requireVerifiedEmail` ミドルウェアを使います。

6. **確認済みのユーザーを考慮する**: 新しいトークンを送る前に、`isEmailVerified()` で確認済みかどうかを調べます。

7. **データベースのストレージを使う**: `MemoryEmailVerificationStore` はテスト専用です。

8. **登録時に送信する**: ユーザー登録のときに、確認メールを自動で送ります。
