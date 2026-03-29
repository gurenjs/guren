# パスワードリセットガイド

Guren はトークン生成、検証、有効期限を備えたセキュアなパスワードリセットシステムを提供します。トークンはセキュリティのため、保存前にハッシュ化されます。

## コアコンセプト

- **PasswordResetTokenStore** – パスワードリセットトークンを保存するためのインターフェース。
- **トークンハッシュ化** – トークンは保存前にSHA-256/SHA-512でハッシュ化される。
- **自動クリーンアップ** – 新しいトークン作成時に同じメールの既存トークンが無効化される。
- **有効期限** – トークンは設定可能な時間後に期限切れになる（デフォルト: 1時間）。

## 基本的な使い方

### パスワードリセットトークンの作成

```ts
import { createPasswordResetToken, MemoryPasswordResetStore } from '@guren/core'

const store = new MemoryPasswordResetStore() // 本番環境ではデータベースを使用

// パスワードリセットトークンを作成
const { token, expiresAt } = await createPasswordResetToken(
  'user@example.com',
  store
)

// トークンをメールでユーザーに送信
await sendPasswordResetEmail(email, token)
```

### トークンの検証

```ts
import { verifyPasswordResetToken } from '@guren/core'

// リセットURLからトークンを検証
const email = await verifyPasswordResetToken(token, store)

if (!email) {
  return ctx.json({ error: '無効または期限切れのトークン' }, 400)
}

// トークンは有効、パスワードリセットフォームを表示
return ctx.json({ email })
```

### パスワードリセットの完了

```ts
import { completePasswordReset } from '@guren/core'

const user = await completePasswordReset(
  token,
  newPassword,
  store,
  userProvider,
  async (user, password) => {
    // パスワードをハッシュ化して更新
    user.password = await hashPassword(password)
    await user.save()
  }
)

if (!user) {
  return ctx.json({ error: '無効なトークンまたはユーザーが見つかりません' }, 400)
}

return ctx.json({ message: 'パスワードが正常に更新されました' })
```

## 完全な実装例

### ルート

```ts
import { Router } from '@guren/core'
import { PasswordResetController } from '@/app/Controllers/PasswordResetController'

export function registerWebRoutes(router: Router): void {
  router.post('/forgot-password', [PasswordResetController, 'sendResetLink'])
  router.get('/reset-password', [PasswordResetController, 'showResetForm'])
  router.post('/reset-password', [PasswordResetController, 'resetPassword'])
}
```

### コントローラー

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
  email: z.string().email(),
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

    // メール列挙攻撃を防ぐため常に成功を返す
    const user = await User.where('email', email).first()

    if (user) {
      const { token } = await createPasswordResetToken(email, this.store, {
        expiresIn: 60 * 60 * 1000, // 1時間
      })

      const resetUrl = buildPasswordResetUrl(
        `${process.env.APP_URL}/reset-password`,
        token,
        email
      )

      await this.sendResetEmail(user, resetUrl)
    }

    return this.json({
      message: 'メールが登録されている場合、リセットリンクが送信されます',
    })
  }

  async showResetForm() {
    const token = this.request.query('token')
    const email = await verifyPasswordResetToken(token, this.store)

    if (!email) {
      return this.inertia(pages.auth.ResetPassword, {
        error: '無効または期限切れのリセットリンク',
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
      return this.json({ error: '無効または期限切れのトークン' }, 400)
    }

    return this.json({ message: 'パスワードがリセットされました' })
  }

  private async sendResetEmail(user: User, resetUrl: string) {
    await mail.send({
      to: user.email,
      subject: 'パスワードリセット',
      html: `
        <h1>パスワードリセットリクエスト</h1>
        <p>以下のリンクをクリックしてパスワードをリセットしてください：</p>
        <a href="${resetUrl}">パスワードをリセット</a>
        <p>このリンクは1時間で期限切れになります。</p>
        <p>このリクエストに心当たりがない場合は、このメールを無視してください。</p>
      `,
    })
  }
}
```

## URLヘルパー

### リセットURLの構築

```ts
import { buildPasswordResetUrl } from '@guren/core'

// トークン付きの基本URL
const url = buildPasswordResetUrl('https://example.com/reset', token)
// 結果: https://example.com/reset?token=abc123...

// メールパラメータ付き
const urlWithEmail = buildPasswordResetUrl(
  'https://example.com/reset',
  token,
  'user@example.com'
)
// 結果: https://example.com/reset?token=abc123...&email=user%40example.com
```

### リセットURLの解析

```ts
import { parsePasswordResetUrl } from '@guren/core'

const { token, email } = parsePasswordResetUrl(
  'https://example.com/reset?token=abc123&email=user%40example.com'
)

console.log(token) // 'abc123'
console.log(email) // 'user@example.com'
```

## データベースストレージ

### PasswordResetTokenStoreの実装

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

    // 期限切れかチェック
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

  // オプション: 期限切れトークンのクリーンアップ
  async cleanupExpired(): Promise<void> {
    await db.delete(passwordResets)
      .where(lt(passwordResets.expiresAt, new Date()))
  }
}
```

### データベーススキーマ

```ts
// db/schema.ts
import { pgTable, text, timestamp } from 'drizzle-orm/pg-core'

export const passwordResets = pgTable('password_resets', {
  tokenHash: text('token_hash').primaryKey(),
  email: text('email').notNull(),
  expiresAt: timestamp('expires_at').notNull(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
})
```

## 設定

### トークンオプション

```ts
interface PasswordResetConfig {
  /** トークン有効期限（ミリ秒、デフォルト: 1時間） */
  expiresIn?: number
  /** ハッシュアルゴリズム（デフォルト: 'sha256'） */
  hashAlgorithm?: 'sha256' | 'sha512'
  /** エンコード前のトークンバイト長（デフォルト: 32） */
  tokenLength?: number
}

// カスタム設定の例
const { token } = await createPasswordResetToken(email, store, {
  expiresIn: 30 * 60 * 1000, // 30分
  hashAlgorithm: 'sha512',
  tokenLength: 64,
})
```

## テスト

```ts
import { describe, test, expect, beforeEach } from 'bun:test'
import {
  createPasswordResetToken,
  verifyPasswordResetToken,
  completePasswordReset,
  MemoryPasswordResetStore,
} from '@guren/core'

describe('パスワードリセット', () => {
  let store: MemoryPasswordResetStore

  beforeEach(() => {
    store = new MemoryPasswordResetStore()
  })

  test('トークンを作成し検証する', async () => {
    const { token } = await createPasswordResetToken('user@example.com', store)

    const email = await verifyPasswordResetToken(token, store)

    expect(email).toBe('user@example.com')
  })

  test('期限切れトークンを拒否する', async () => {
    const { token } = await createPasswordResetToken('user@example.com', store, {
      expiresIn: -1000, // すでに期限切れ
    })

    const email = await verifyPasswordResetToken(token, store)

    expect(email).toBeNull()
  })

  test('新しいリクエストで以前のトークンを無効化する', async () => {
    const { token: oldToken } = await createPasswordResetToken('user@example.com', store)
    const { token: newToken } = await createPasswordResetToken('user@example.com', store)

    expect(await verifyPasswordResetToken(oldToken, store)).toBeNull()
    expect(await verifyPasswordResetToken(newToken, store)).toBe('user@example.com')
  })

  test('トークンは一度しか使用できない', async () => {
    const { token } = await createPasswordResetToken('user@example.com', store)

    // 初回使用
    const user = await completePasswordReset(
      token,
      'new-password',
      store,
      userProvider,
      async (u, p) => { u.password = p }
    )
    expect(user).not.toBeNull()

    // 2回目は失敗すべき
    const email = await verifyPasswordResetToken(token, store)
    expect(email).toBeNull()
  })
})
```

## ベストプラクティス

1. **パスワード忘れは常に成功を返す**: メール列挙攻撃を防ぐため、常に成功メッセージを表示。

2. **短い有効期限を使用**: パスワードリセットトークンは短時間（15〜60分）で期限切れにすべき。

3. **パスワード変更時に無効化**: ユーザーがパスワードを変更したら、すべてのリセットトークンを削除。

4. **リクエストをレート制限**: パスワード忘れエンドポイントをレート制限して乱用を防止。

5. **HTTPSを使用**: リセットリンクには機密性の高いトークンが含まれるため、HTTPS経由で送信する必要がある。

6. **メールにパスワードを含めない**: リセットリンクのみを送信し、新しいパスワードは決して送信しない。

7. **リセット試行をログ**: セキュリティ監査のためパスワードリセットリクエストをログ。

8. **パスワード変更をユーザーに通知**: パスワードが正常に変更されたらメールを送信。
