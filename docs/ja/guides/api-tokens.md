# APIトークンガイド

Guren はAPIリクエストを認証するためのセキュアなAPIトークンシステムを提供します。トークンは保存前にハッシュ化され、abilities（スコープ）をサポートし、有効期限を設定できます。

## コアコンセプト

- **ApiToken** – データベースに保存されるトークンデータ（ハッシュ化され、プレーンテキストは保存されない）。
- **ApiTokenStore** – トークンストレージのインターフェース（メモリまたはデータベース）。
- **Bearerトークンミドルウェア** – Authorizationヘッダーを使用してリクエストを認証。
- **Abilities** – トークンが実行できるアクションを定義するスコープ。

## 基本的な使い方

### トークンの作成

```ts
import { createApiToken, MemoryApiTokenStore } from '@guren/core'

const store = new MemoryApiTokenStore() // 本番環境ではデータベースを使用

// ユーザー用のトークンを作成
const { plainTextToken, token } = await createApiToken(store, {
  name: 'モバイルアプリトークン',
  userId: user.id,
  abilities: ['posts:read', 'posts:write'],
  expiresIn: 30 * 24 * 60 * 60 * 1000, // 30日
})

// plainTextTokenをユーザーに返す - これが利用可能な唯一の機会！
return ctx.json({ token: plainTextToken })
```

### トークンフォーマット

トークンは`{id}|{token}`形式で返されます。

```
abc123def456...|xyz789ghi012...
```

トークン部分は保存前にハッシュ化されます。プレーンテキストのトークンは復元できません。

### トークンの検証

```ts
import { verifyApiToken } from '@guren/core'

const result = await verifyApiToken(plainTextToken, store)

if (!result) {
  return ctx.json({ error: '無効なトークン' }, 401)
}

console.log(result.userId)     // ユーザーID
console.log(result.abilities)  // ['posts:read', 'posts:write']
console.log(result.token)      // トークンメタデータ（プレーンテキストなし）
```

## トークンAbilities

### Abilitiesの確認

```ts
import { tokenCan, tokenCanAll, tokenCanAny } from '@guren/core'

const token = { abilities: ['posts:read', 'posts:write'] }

// 単一のabilityを確認
tokenCan(token, 'posts:read')    // true
tokenCan(token, 'posts:delete')  // false

// すべてのabilitiesを確認
tokenCanAll(token, ['posts:read', 'posts:write'])   // true
tokenCanAll(token, ['posts:read', 'posts:delete'])  // false

// いずれかのabilityを確認
tokenCanAny(token, ['posts:read', 'posts:delete'])  // true
tokenCanAny(token, ['users:read', 'users:write'])   // false
```

### ワイルドカードAbility

`*`を使用してすべてのabilitiesを付与できます。

```ts
const { plainTextToken } = await createApiToken(store, {
  name: '管理者トークン',
  userId: user.id,
  abilities: ['*'], // すべての操作が可能
})

tokenCan({ abilities: ['*'] }, 'anything')  // true
```

## Bearerトークンミドルウェア

### 基本セットアップ

```ts
import { createBearerTokenMiddleware } from '@guren/core'

// すべてのAPIルートを保護
app.use('/api/*', createBearerTokenMiddleware({ store }))
```

### Ability要件付き

```ts
import { Router } from '@guren/core'

// ルートに特定のabilitiesを要求
export function registerApiRoutes(router: Router): void {
  router.delete('/api/posts/:id', [PostController, 'destroy']).middleware(
    createBearerTokenMiddleware({
      store,
      abilities: ['posts:delete'],
    }),
  )
}
```

### ユーザー読み込み付き

```ts
app.use('/api/*', createBearerTokenMiddleware({
  store,
  loadUser: async (userId) => {
    return User.find(userId)
  },
}))

// コンテキストでユーザーが利用可能に
router.get('/api/me', (ctx) => {
  const user = ctx.get('guren:user')
  return ctx.json(user)
})
```

### カスタムエラーハンドラー

```ts
app.use('/api/*', createBearerTokenMiddleware({
  store,
  onUnauthorized: (ctx) => {
    return ctx.json({ error: '有効なAPIトークンを提供してください' }, 401)
  },
  onForbidden: (ctx, requiredAbilities) => {
    return ctx.json({
      error: '権限が不足しています',
      required: requiredAbilities,
    }, 403)
  },
}))
```

### ルートでトークンにアクセス

```ts
import { getApiToken } from '@guren/core'

router.get('/api/token-info', (ctx) => {
  const tokenInfo = getApiToken(ctx)

  if (!tokenInfo) {
    return ctx.json({ error: '認証されていません' }, 401)
  }

  return ctx.json({
    userId: tokenInfo.userId,
    tokenName: tokenInfo.token.name,
    abilities: tokenInfo.abilities,
    lastUsedAt: tokenInfo.token.lastUsedAt,
  })
})
```

## トークン管理

### ユーザーのトークン一覧

```ts
import { getUserApiTokens } from '@guren/core'

router.get('/api/tokens', async (ctx) => {
  const user = ctx.get('guren:user')
  const tokens = await getUserApiTokens(user.id, store)

  return ctx.json({
    tokens: tokens.map(t => ({
      id: t.id,
      name: t.name,
      abilities: t.abilities,
      lastUsedAt: t.lastUsedAt,
      createdAt: t.createdAt,
      expiresAt: t.expiresAt,
    })),
  })
})
```

### トークンの無効化

```ts
import { revokeApiToken, revokeAllApiTokens } from '@guren/core'

// 特定のトークンを無効化
router.delete('/api/tokens/:id', async (ctx) => {
  const tokenId = ctx.req.param('id')
  await revokeApiToken(tokenId, store)
  return ctx.json({ message: 'トークンが無効化されました' })
})

// すべてのトークンを無効化（パスワード変更時など）
router.post('/api/tokens/revoke-all', async (ctx) => {
  const user = ctx.get('guren:user')
  await revokeAllApiTokens(user.id, store)
  return ctx.json({ message: 'すべてのトークンが無効化されました' })
})
```

## データベースストレージ

### 組み込みの DatabaseApiTokenStore

本番環境では組み込みの `DatabaseApiTokenStore` を使います。`api_tokens` スキーマの Drizzle テーブルを渡すだけで、カスタムストアの実装は不要です。

```ts
import { DatabaseApiTokenStore } from '@guren/core'
import { apiTokens } from '@/db/schema'

const store = new DatabaseApiTokenStore(apiTokens)

// すべてのトークンヘルパーで利用可能
const { plainTextToken } = await createApiToken(store, {
  name: 'Mobile App Token',
  userId: user.id,
})
```

ストアはアプリで設定済みの ORM 接続（標準の `DatabaseProvider` セットアップ）を利用するため、追加の配線は不要です。期限切れトークンは `verifyApiToken` が拒否します。テーブルから削除するには、スケジュールジョブから `store.deleteExpired()` を呼んでください。

### データベーススキーマ

カラムのプロパティ名は `ApiToken` のフィールドと一致させます。

```ts
// db/schema.ts
import { pgTable, text, timestamp, jsonb } from 'drizzle-orm/pg-core'

export const apiTokens = pgTable('api_tokens', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  hashedToken: text('hashed_token').notNull().unique(),
  userId: text('user_id').notNull(),
  abilities: jsonb('abilities').$type<string[]>().notNull(),
  lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})
```

`abilities` カラムが `jsonb` ではなく JSON 文字列を保持する text カラムの場合は、`{ abilitiesMode: 'text' }` を渡します。

```ts
const store = new DatabaseApiTokenStore(apiTokens, { abilitiesMode: 'text' })
```

### カスタムストア

`ApiTokenStore` インターフェースを実装したオブジェクトであれば何でも利用できます。トークンを外部システムに保存する場合は自前で実装してください。

```ts
import type { ApiTokenStore, ApiToken } from '@guren/core'

export class ExternalApiTokenStore implements ApiTokenStore {
  async store(token: ApiToken): Promise<void> { /* ... */ }
  async findByHashedToken(hashedToken: string): Promise<ApiToken | null> { /* ... */ }
  async findByUserId(userId: string | number): Promise<ApiToken[]> { /* ... */ }
  async delete(id: string): Promise<void> { /* ... */ }
  async deleteForUser(userId: string | number): Promise<void> { /* ... */ }
  async updateLastUsed(id: string, timestamp: Date): Promise<void> { /* ... */ }
}
```

## 設定オプション

### トークン作成オプション

```ts
interface CreateApiTokenOptions {
  name: string                // 人間が読めるトークン名
  userId: string | number     // 所有者のユーザーID
  abilities?: string[]        // トークンスコープ（デフォルト: ['*']）
  expiresIn?: number | null   // 有効期限までのミリ秒
  tokenLength?: number        // トークンバイト数（デフォルト: 32）
}
```

### ミドルウェアオプション

```ts
interface BearerTokenMiddlewareOptions {
  store: ApiTokenStore                                     // トークンストレージ
  loadUser?: (userId: string | number) => Promise<unknown> // ユーザーローダー
  abilities?: string[]                                     // 必要なabilities
  onUnauthorized?: (ctx: Context) => Response             // 401ハンドラー
  onForbidden?: (ctx: Context, required: string[]) => Response  // 403ハンドラー
  headerName?: string                                      // ヘッダー名（デフォルト: 'Authorization'）
  updateLastUsed?: boolean                                 // 使用状況追跡（デフォルト: true）
}
```

## テスト

```ts
import { describe, test, expect, beforeEach } from 'bun:test'
import {
  createApiToken,
  verifyApiToken,
  MemoryApiTokenStore,
  createBearerTokenMiddleware,
} from '@guren/core'
import { Hono } from 'hono'

describe('APIトークン', () => {
  let store: MemoryApiTokenStore

  beforeEach(() => {
    store = new MemoryApiTokenStore()
  })

  test('トークンを作成し検証する', async () => {
    const { plainTextToken, token } = await createApiToken(store, {
      name: 'テストトークン',
      userId: 1,
      abilities: ['read'],
    })

    expect(plainTextToken).toMatch(/^[a-f0-9]+\|[a-f0-9]+$/)

    const result = await verifyApiToken(plainTextToken, store)
    expect(result?.userId).toBe(1)
    expect(result?.abilities).toEqual(['read'])
  })

  test('期限切れトークンを拒否する', async () => {
    const { plainTextToken } = await createApiToken(store, {
      name: 'テストトークン',
      userId: 1,
      expiresIn: -1000, // すでに期限切れ
    })

    const result = await verifyApiToken(plainTextToken, store)
    expect(result).toBeNull()
  })

  test('ミドルウェアがリクエストを認証する', async () => {
    const { plainTextToken } = await createApiToken(store, {
      name: 'テストトークン',
      userId: 1,
    })

    const app = new Hono()
    app.use('*', createBearerTokenMiddleware({ store }))
    app.get('/', (c) => c.text('OK'))

    const res = await app.request('/', {
      headers: { Authorization: `Bearer ${plainTextToken}` },
    })

    expect(res.status).toBe(200)
  })

  test('ミドルウェアがabilitiesを確認する', async () => {
    const { plainTextToken } = await createApiToken(store, {
      name: 'テストトークン',
      userId: 1,
      abilities: ['read'],
    })

    const app = new Hono()
    app.use('*', createBearerTokenMiddleware({
      store,
      abilities: ['write'],
    }))
    app.get('/', (c) => c.text('OK'))

    const res = await app.request('/', {
      headers: { Authorization: `Bearer ${plainTextToken}` },
    })

    expect(res.status).toBe(403)
  })
})
```

## ベストプラクティス

1. **プレーントークンを保存しない**: ハッシュ化されたトークンのみが保存される。プレーンテキストは作成時に一度だけ表示。

2. **具体的なabilitiesを使用**: セキュリティ向上のため、`['*']`よりも`['posts:read', 'posts:write']`を推奨。

3. **有効期限を設定**: セキュリティのためトークンには有効期限を設定。30〜90日が一般的。

4. **パスワード変更時に無効化**: ユーザーがパスワードを変更したら、すべてのトークンを無効化。

5. **本番環境ではデータベースストレージを使用**: `MemoryApiTokenStore`はテスト用のみ。

6. **最終使用日時を追跡**: `lastUsedAt`フィールドで未使用トークンを特定。

7. **トークンに意味のある名前を付ける**: 識別しやすいよう「モバイルアプリ」「CI/CDパイプライン」などの名前を使用。

8. **トークンローテーションを実装**: ユーザーが定期的にトークンを再生成できるようにする。
