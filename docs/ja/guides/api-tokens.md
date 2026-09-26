# APIトークンガイド

API リクエストの認証には、Guren の API トークンを使えます。トークンは保存する前にハッシュ化され、abilities（スコープ）と有効期限を指定できます。

## コアコンセプト

- **ApiToken**: データベースに保存するトークンのデータ。ハッシュ化した値だけを保存し、平文は保存しません
- **ApiTokenStore**: トークンの保存先のインターフェース（メモリまたはデータベース）
- **Bearerトークンミドルウェア**: Authorization ヘッダーを見てリクエストを認証するミドルウェア
- **Abilities**: トークンに許す操作を決めるスコープ

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

トークンは `{id}|{token}` の形式で返されます。

```
abc123def456...|xyz789ghi012...
```

`{token}` の部分は保存する前にハッシュ化されるので、平文のトークンを後から復元することはできません。

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

`*` を指定すると、すべての abilities を与えられます。

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

読み込んだユーザーは、そのリクエストの呼び出し主体（principal）になります。コントローラの `this.auth.user()`、`requireAuthenticated()`、Gate（Policy、`this.authorize()`、`authorizeMiddleware()`）は、どれもこのユーザーを返します。呼び出し主体は auth context ではなくリクエストに記録されるので、ミドルウェアを `boot()` の前にマウントしても後にマウントしても読み取れます。

このリクエストで `auth.logout()` を呼ぶと、送られてきたトークンが失効し、同じリクエストにあるセッションはそのまま残ります。`loadUser` が `null` を返したリクエストは、未認証として扱われます。トークンの検証そのものは通っていて、そのリクエストはトークンに属するものなので、ログイン中のセッションのユーザーが代わりに使われることはありません。ミドルウェアが実行されなかったリクエストでは、セッションのユーザーがそのまま使われます。`useTokens({ provider })` を設定している場合は、読み込んだユーザーからその provider が機密項目を取り除く（sanitize）ので、パスワードハッシュやモデルの `hidden` フィールドが auth 層の外に出ることはありません。

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

本番環境では、組み込みの `DatabaseApiTokenStore` を使います。`api_tokens` スキーマの Drizzle テーブルを渡すだけでよく、独自のストアを実装する必要はありません。

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

ストアはアプリで設定済みの ORM の接続（標準の `DatabaseProvider` の構成）を使うので、ほかに何かをつなぐ必要はありません。期限切れのトークンは `verifyApiToken` が拒否します。テーブルから消すには、スケジュールしたジョブから `store.deleteExpired()` を呼んでください。

### データベーススキーマ

カラムのプロパティ名は、`ApiToken` のフィールド名と揃えます。

```ts
// db/schema.ts
import { pgTable, text, timestamp, jsonb } from '@guren/orm/drizzle/pg'

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

SQLite では、timestamp のカラムを `text` か `integer(..., { mode: 'timestamp_ms' })` で宣言します。`text` は ISO 文字列を入れる形で、`create-guren-app` が `users.created_at` に使っているのと同じです。ストアは、各カラムの宣言に合わせた値を書き込みます。drizzle の timestamp モードのカラムには Date を、text のカラムには ISO 文字列を、モードを指定していない integer のカラムにはエポックミリ秒を書きます。

```ts
// db/schema.ts
import { sqliteTable, text } from '@guren/orm/drizzle/sqlite'

export const apiTokens = sqliteTable('api_tokens', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  hashedToken: text('hashed_token').notNull().unique(),
  userId: text('user_id').notNull(),
  abilities: text('abilities', { mode: 'json' }).$type<string[]>().notNull(),
  lastUsedAt: text('last_used_at'),
  expiresAt: text('expires_at'),
  createdAt: text('created_at').notNull(),
})
```

`abilities` カラムが `jsonb` ではなく、JSON 文字列を入れる text のカラムなら、`{ abilitiesMode: 'text' }` を渡します。

```ts
const store = new DatabaseApiTokenStore(apiTokens, { abilitiesMode: 'text' })
```

### カスタムストア

`ApiTokenStore` インターフェースを実装したオブジェクトなら、どれでもストアとして使えます。トークンを外部のシステムに保存したいときは、自分で実装してください。

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

1. **平文のトークンを保存しない**: 保存するのはハッシュ化したトークンだけにし、平文は作成時に一度だけ表示します。

2. **abilities を具体的に指定する**: `['*']` ではなく、`['posts:read', 'posts:write']` のように絞ります。

3. **有効期限を設定する**: トークンには有効期限を付けます。30〜90 日がよく使われます。

4. **パスワード変更時に無効化する**: ユーザーがパスワードを変えたら、そのユーザーのトークンをすべて無効化します。

5. **本番環境ではデータベースに保存する**: `MemoryApiTokenStore` はテスト専用です。

6. **最終使用日時を追う**: `lastUsedAt` フィールドを見れば、使われていないトークンが見つかります。

7. **トークンにわかりやすい名前を付ける**: 「モバイルアプリ」「CI/CDパイプライン」のように、見ただけで用途がわかる名前にします。

8. **トークンのローテーションを用意する**: ユーザーが定期的にトークンを作り直せるようにします。
