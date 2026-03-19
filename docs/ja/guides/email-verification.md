# メール認証ガイド

Gurenはトークン生成、検証、有効期限を備えたセキュアなメール認証システムを提供します。トークンはセキュリティのため、保存前にハッシュ化されます。

## コアコンセプト

- **EmailVerificationTokenStore** – 認証トークンを保存するためのインターフェース。
- **トークンハッシュ化** – トークンは保存前にSHA-256でハッシュ化される。
- **平文は保存しない** – トークンはハッシュのみ保存。
- **一度きりの使用** – トークンは認証成功後に削除される。
- **有効期限** – トークンは設定可能な時間後に期限切れになる（デフォルト: 24時間）。

## 基本的な使い方

### 認証トークンの作成

```ts
import { createEmailVerificationToken, MemoryEmailVerificationStore } from '@guren/core'

const store = new MemoryEmailVerificationStore() // 本番環境ではデータベースを使用

// 認証トークンを作成
const { token, expiresAt } = await createEmailVerificationToken(
  'user@example.com',
  store
)

// 認証メールを送信
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

### 認証の完了

```ts
import { completeEmailVerification } from '@guren/core'

const user = await completeEmailVerification(
  token,
  store,
  async (email) => {
    // ユーザーを認証済みとしてマーク
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
import { Route } from '@guren/server'
import { VerificationController } from '@/app/Controllers/VerificationController'

Route.middleware(['auth']).group(() => {
  Route.get('/email/verify', [VerificationController, 'notice'])
  Route.post('/email/resend', [VerificationController, 'resend'])
})

Route.get('/email/verify/:token', [VerificationController, 'verify'])
```

### コントローラー

```ts
import { Controller } from '@guren/server'
import {
  createEmailVerificationToken,
  completeEmailVerification,
  buildVerificationUrl,
  isEmailVerified,
} from '@guren/core'
import { User } from '@/app/Models/User'

export class VerificationController extends Controller {
  private store = new DatabaseEmailVerificationStore()

  async notice() {
    const user = await this.auth.user()

    if (isEmailVerified(user)) {
      return this.redirect('/dashboard')
    }

    return this.inertia('Auth/VerifyEmail', {
      email: user.email,
    })
  }

  async resend() {
    const user = await this.auth.user()

    if (isEmailVerified(user)) {
      return this.json({ message: 'すでに認証済みです' })
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

    return this.json({ message: '認証メールを送信しました' })
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
      return this.inertia('Auth/VerifyEmail', {
        error: '無効または期限切れの認証リンク',
      })
    }

    return this.redirect('/dashboard?verified=1')
  }

  private async sendVerificationEmail(user: User, verifyUrl: string) {
    await mail.send({
      to: user.email,
      subject: 'メールアドレスを確認してください',
      html: `
        <h1>メール認証</h1>
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

### 認証状態の確認

```ts
import { isEmailVerified } from '@guren/core'

// ユーザーが認証済みか確認
if (isEmailVerified(user)) {
  // ユーザーのメールは認証済み
}

// nullableなユーザーでも動作
if (!isEmailVerified(null)) {
  // nullの場合はfalseを返す
}
```

### メール認証必須ミドルウェア

```ts
import { requireVerifiedEmail } from '@guren/core'
import { Route } from '@guren/server'

// 未認証ユーザーをリダイレクト
Route.get('/dashboard', [DashboardController, 'index']).middleware(
  requireVerifiedEmail({ redirectTo: '/email/verify' })
)

// カスタムユーザー取得
Route.get('/profile', [ProfileController, 'show']).middleware(
  requireVerifiedEmail({
    redirectTo: '/verify-email',
    getUser: async (ctx) => {
      return ctx.get('user')
    },
  })
)
```

## URLヘルパー

### 認証URLの構築

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

### 認証URLの解析

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

### データベーススキーマ

```ts
// db/schema.ts
import { pgTable, text, timestamp } from 'drizzle-orm/pg-core'

export const emailVerifications = pgTable('email_verifications', {
  hashedToken: text('hashed_token').primaryKey(),
  email: text('email').notNull(),
  expiresAt: timestamp('expires_at').notNull(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
})

// usersテーブルにはemailVerifiedAtを含める
export const users = pgTable('users', {
  id: serial('id').primaryKey(),
  email: text('email').notNull().unique(),
  emailVerifiedAt: timestamp('email_verified_at'),
  // ... その他のフィールド
})
```

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

describe('メール認証', () => {
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

  test('認証を完了しトークンを消費する', async () => {
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
async register() {
  const { name, email, password } = await this.validate({
    name: z.string().min(2),
    email: z.string().email(),
    password: z.string().min(8),
  })

  // ユーザーを作成
  const user = await User.create({
    name,
    email,
    password: await Bun.password.hash(password),
    emailVerifiedAt: null,
  })

  // 認証トークンを作成
  const { token } = await createEmailVerificationToken(email, this.store)

  // 認証メールを送信
  const verifyUrl = buildVerificationUrl(
    `${process.env.APP_URL}/email/verify`,
    token
  )
  await this.sendVerificationEmail(user, verifyUrl)

  // ユーザーをログイン
  await this.auth.login(user)

  // 認証通知ページへリダイレクト
  return this.redirect('/email/verify')
}
```

## ベストプラクティス

1. **長めの有効期限を使用**: メール認証トークンは24〜72時間で安全に期限切れにできる。

2. **メールを正規化**: 大文字小文字の問題を防ぐため、メールは小文字で保存。

3. **再送信を許可**: ユーザーが必要に応じて新しい認証メールをリクエストできるようにする。

4. **古いトークンをクリア**: 新しいトークン作成時に同じメールの古いトークンが自動的に削除される。

5. **ルートを保護**: 認証済みユーザーが必要なルートには`requireVerifiedEmail`ミドルウェアを使用。

6. **認証済みを処理**: 新しいトークンを送信する前に`isEmailVerified()`をチェック。

7. **データベースストレージを使用**: `MemoryEmailVerificationStore`はテスト用のみ。

8. **登録時に送信**: ユーザー登録時に自動的に認証メールを送信。
