# バリデーション

Guren は Zod やその他のスキーマバリデーションライブラリと統合する柔軟なバリデーションシステムを提供しています。ミドルウェアレベルまたはコントローラー内でリクエストデータを検証できます。

## クイックスタート

Zod スキーマと `validateRequest()` ミドルウェアを使用：

```ts
import { Route, validateRequest, getValidatedData } from '@guren/server'
import { z } from 'zod'

const createPostSchema = z.object({
  title: z.string().min(1).max(200),
  content: z.string().min(10),
  published: z.boolean().optional().default(false),
})

Route.post('/posts', async (ctx) => {
  const data = getValidatedData<z.infer<typeof createPostSchema>>(ctx)
  // data は完全に型付けされ、検証済み
  return ctx.json({ post: await Post.create(data) })
}, validateRequest(createPostSchema))
```

## ミドルウェアバリデーション

### `validateRequest(schema)`

バリデーションミドルウェアを作成するファクトリ：

```ts
import { validateRequest } from '@guren/server'
import { z } from 'zod'

const schema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
})

Route.post('/login', [AuthController, 'login'], validateRequest(schema))
```

デフォルトでは、バリデーションエラーはエラー詳細を含む 422 レスポンスを返します。

### `validateRequestWith(schemaFactory)`

リクエストコンテキストに基づく動的スキーマ用：

```ts
import { validateRequestWith } from '@guren/server'

Route.put('/users/:id', [UserController, 'update'], validateRequestWith((ctx) => {
  const isAdmin = ctx.get('user')?.role === 'admin'

  return z.object({
    name: z.string().min(1),
    email: z.string().email(),
    // 管理者のみロール変更可能
    role: isAdmin ? z.enum(['user', 'admin']) : z.never().optional(),
  })
}))
```

## 検証済みデータの取得

バリデーションミドルウェア実行後、`getValidatedData()` で型付きデータを取得：

```ts
import { getValidatedData } from '@guren/server'
import type { z } from 'zod'

Route.post('/posts', async (ctx) => {
  const data = getValidatedData<z.infer<typeof createPostSchema>>(ctx)

  // TypeScript は正確な型を認識
  console.log(data.title)  // string
  console.log(data.content) // string
  console.log(data.published) // boolean

  return ctx.json({ post: await Post.create(data) })
}, validateRequest(createPostSchema))
```

## 手動バリデーション

ミドルウェア外でのバリデーションには `validate()` または `validateSafe()` を使用：

```ts
import { validate, validateSafe } from '@guren/server'

// バリデーション失敗時に例外をスロー
const data = validate(schema, requestData)

// 結果オブジェクトを返す（例外をスローしない）
const result = validateSafe(schema, requestData)
if (result.success) {
  console.log(result.data)
} else {
  console.log(result.error)
}
```

## カスタムエラーハンドリング

デフォルトのエラーレスポンスをオーバーライド：

```ts
validateRequest(schema, {
  onError: (ctx, error) => {
    // カスタムエラーフォーマット
    return ctx.json({
      message: 'バリデーションに失敗しました',
      errors: error.issues.map(issue => ({
        field: issue.path.join('.'),
        message: issue.message,
      })),
    }, 422)
  },
})
```

## スキーマインターフェース

Guren のバリデーションはスキーマライブラリに依存しません。`ValidationSchema` を実装する任意のオブジェクトが使用可能：

```ts
interface ValidationSchema<T> {
  parse(data: unknown): T
  safeParse(data: unknown): { success: true; data: T } | { success: false; error: unknown }
}
```

これにより Zod、Valibot、カスタムバリデーターが使用可能：

```ts
// Valibot を使用
import * as v from 'valibot'

const schema = v.object({
  name: v.string([v.minLength(1)]),
  email: v.string([v.email()]),
})

Route.post('/users', handler, validateRequest(schema))
```

## 一般的なパターン

### ネストされたオブジェクト

```ts
const addressSchema = z.object({
  street: z.string(),
  city: z.string(),
  postalCode: z.string().regex(/^\d{3}-\d{4}$/),
})

const userSchema = z.object({
  name: z.string(),
  address: addressSchema,
})
```

### 配列

```ts
const schema = z.object({
  tags: z.array(z.string()).min(1).max(10),
  items: z.array(z.object({
    productId: z.number(),
    quantity: z.number().positive(),
  })),
})
```

### デフォルト値付きオプショナル

```ts
const schema = z.object({
  page: z.coerce.number().positive().default(1),
  perPage: z.coerce.number().positive().max(100).default(20),
  sortBy: z.enum(['created', 'updated', 'name']).default('created'),
})
```

### 変換

```ts
const schema = z.object({
  email: z.string().email().toLowerCase(),
  tags: z.string().transform(s => s.split(',').map(t => t.trim())),
  date: z.string().transform(s => new Date(s)),
})
```

### 絞り込み

```ts
const schema = z.object({
  password: z.string().min(8),
  confirmPassword: z.string(),
}).refine(data => data.password === data.confirmPassword, {
  message: 'パスワードが一致しません',
  path: ['confirmPassword'],
})
```

## フォームバリデーションエラー

バリデーション失敗時のデフォルトレスポンス形式：

```json
{
  "error": "Validation failed",
  "issues": [
    {
      "path": ["email"],
      "message": "Invalid email"
    },
    {
      "path": ["password"],
      "message": "String must contain at least 8 character(s)"
    }
  ]
}
```

### Inertia での表示

バリデーションエラーをフロントエンドに渡す：

```ts
// Controller
async store() {
  try {
    const data = validate(schema, await this.ctx.req.json())
    await User.create(data)
    return this.redirect('/users')
  } catch (error) {
    if (error instanceof z.ZodError) {
      return this.inertia('Users/Create', {
        errors: formatValidationErrors(error),
      })
    }
    throw error
  }
}
```

```tsx
// React コンポーネント
function CreateUser({ errors }: { errors?: Record<string, string> }) {
  return (
    <form>
      <input name="email" />
      {errors?.email && <span className="error">{errors.email}</span>}

      <input name="password" type="password" />
      {errors?.password && <span className="error">{errors.password}</span>}
    </form>
  )
}
```

## 型安全なリクエストパース

完全な型安全性のため、リクエストパースと組み合わせ：

```ts
import { parseRequestPayload, validateRequest, getValidatedData } from '@guren/server'

const schema = z.object({
  title: z.string(),
  content: z.string(),
})

Route.post('/posts', async (ctx) => {
  const data = getValidatedData<z.infer<typeof schema>>(ctx)!
  // 完全に型付けされ、検証済みのデータ
  return ctx.json({ post: await Post.create(data) })
}, validateRequest(schema))
```
