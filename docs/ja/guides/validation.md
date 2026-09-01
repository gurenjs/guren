# バリデーション

Guren のバリデーションは schema-first が基本です。Zod 互換スキーマをコントローラー、ルートコントラクト、ミドルウェアで使い回し、必要な場合だけ legacy な `FormRequest` 互換レイヤーを使います。

> **サポートする Zod バージョン:** zod 4 API のみです。ランタイムのバリデーション自体は `safeParse` を持つ任意のスキーマを受け付けますが、スキーマを構造的に読むツール — `guren codegen`、OpenAPI 生成、`guren context` — は zod v3 API(旧 `zod@3` パッケージおよび `zod/v3` サブパス)で書かれたスキーマを警告付きで拒否します。スキーマは `import { z } from 'zod'` で書いてください。

## クイックスタート

推奨パターンはコントローラーの validation helper を使う方法です。

```ts
import { Controller, paginate } from '@guren/core'
import { z } from 'zod'
import { Post } from '@/app/Models/Post'
import { PostResource } from '@/app/Http/Resources/PostResource'
import { pages } from '@/.guren/pages.gen'

const StorePostSchema = z.object({
  title: z.string().min(1).max(200),
  content: z.string().min(10),
})

const PageQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
})

export default class PostsController extends Controller {
  async index() {
    const { page } = this.validateQuery(PageQuerySchema)
    const result = await Post.paginate({ page, perPage: 10 })
    const paginator = paginate(result, { path: this.request.path ?? '/posts' })

    return this.inertia(pages.posts.Index, {
      data: result.data.map((post) => new PostResource(post).toJSON()),
      pagination: {
        meta: paginator.meta(),
        links: paginator.links(),
      },
    })
  }

  async store() {
    const data = await this.validateBody(StorePostSchema)
    const post = await Post.create(data)
    return this.created({ post: new PostResource(post).toJSON() })
  }
}
```

## ミドルウェアバリデーション

### `validateRequest(schema)` 互換ミドルウェア

バリデーションミドルウェアを作成するファクトリです。

```ts
import { Router, validateRequest } from '@guren/core'
import { z } from 'zod'

const schema = z.object({
  email: z.email(),
  password: z.string().min(8),
})

const router = new Router()

router.post('/login', [AuthController, 'login'], validateRequest(schema))
```

デフォルトでは、バリデーションエラーはエラー詳細を含む 422 レスポンスを返します。

### `validateRequestWith(schemaFactory)`

リクエストコンテキストに基づく動的スキーマ用です。

```ts
import { Router, validateRequestWith } from '@guren/core'

const router = new Router()

router.put('/users/:id', [UserController, 'update'], validateRequestWith((ctx) => {
  const isAdmin = ctx.get('user')?.role === 'admin'

  return z.object({
    name: z.string().min(1),
    email: z.email(),
    // 管理者のみロール変更可能
    role: isAdmin ? z.enum(['user', 'admin']) : z.never().optional(),
  })
}))
```

## 検証済みデータの取得

バリデーションミドルウェア実行後、`getValidatedData()` で型付きデータを取得できます。

```ts
import { getValidatedData } from '@guren/core'
import type { z } from 'zod'
import { Router } from '@guren/core'

const router = new Router()

router.post('/posts', async (ctx) => {
  const data = getValidatedData<z.infer<typeof createPostSchema>>(ctx)

  // TypeScript は正確な型を認識
  console.log(data.title)  // string
  console.log(data.content) // string
  console.log(data.published) // boolean

  return ctx.json({ post: await Post.create(data) })
}, validateRequest(createPostSchema))
```

## 手動バリデーション

ミドルウェア外でのバリデーションには `validate()` または `validateSafe()` を使用します。

```ts
import { validate, validateSafe } from '@guren/core'

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

デフォルトのエラーレスポンスをオーバーライドできます。

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

Guren のバリデーションはスキーマライブラリに依存しません。`ValidationSchema` を実装する任意のオブジェクトが使用可能です。

```ts
interface ValidationSchema<T> {
  parse(data: unknown): T
  safeParse(data: unknown): { success: true; data: T } | { success: false; error: unknown }
}
```

これにより Zod、Valibot、カスタムバリデーターが使用できます。

```ts
// Valibot を使用
import * as v from 'valibot'
import { Router } from '@guren/core'

const schema = v.object({
  name: v.string([v.minLength(1)]),
  email: v.string([v.email()]),
})

const router = new Router()

router.post('/users', handler, validateRequest(schema))
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
  email: z.email().toLowerCase(),
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

バリデーション失敗時のデフォルトレスポンス形式です。

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

### Inertia リクエストの自動ハンドリング

Inertia リクエスト（`X-Inertia` ヘッダー付き）で `ValidationException` が throw された場合、上記の JSON は返りません。代わりに Laravel と同様に、エラーをセッションに flash して直前のページへ `303` リダイレクトします。次のページロードで flash されたエラーが共有プロップ `errors`（フィールドごとに 1 メッセージへフラット化）として注入されます。

```tsx
function Login({ errors }: { errors?: Record<string, string> }) {
  return (
    <form>
      <input name="email" />
      {errors?.email && <span className="error">{errors.email}</span>}
    </form>
  )
}
```

これは `validateBody` / `validateQuery` / `validateParams` の失敗と、自前のコードから throw した `ValidationException.withMessages(...)` の両方に適用されます。flash にはセッションミドルウェアが必要です（`auth` オプションを設定すると自動でマウントされます）。挙動をカスタマイズしたい場合は、サービスプロバイダで `ValidationException` 用のレンダラーを登録してください。組み込みのレンダラーより優先されます。

### Inertia での表示

page definition に `ValidationErrors<T>` を載せて、コントローラーとコンポーネントで同じ shape を共有します。

```ts
import { type ValidationErrors } from '@guren/core'
import { pages } from '@/.guren/pages.gen'

type CreateUserFields = 'email' | 'password'
type CreateUserProps = {
  errors?: ValidationErrors<CreateUserFields>
}

async store() {
  const result = await this.validateBodySafe(schema)
  if (!result.success) {
    return this.inertia<CreateUserProps>(pages.users.Create, {
      errors: result.errors,
    })
  }

  await User.create(result.data)
  return this.redirect('/users')
}
```

```tsx
import type { PageProps } from '@guren/inertia-client'
import { pages } from '@/.guren/pages.gen'

type Props = PageProps<typeof pages.users.Create>

function CreateUser({ errors }: Props) {
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

## コントローラーバリデーションヘルパー

コントローラーで最もシンプルにバリデーションを行う方法は `validateBody`、`validateQuery`、`validateParams` です。`safeParse()` を持つ任意の Zod ライクなスキーマを受け取り、失敗時に `ValidationException`（422）をスローします。

```ts
import { Controller } from '@guren/core'
import { z } from 'zod'

const StorePostSchema = z.object({
  title: z.string().min(1).max(200),
  content: z.string().min(10),
})

const PostIdParamSchema = z.object({
  id: z.coerce.number().int().positive(),
})

const PageQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
})

export default class PostsController extends Controller {
  async index() {
    const { page } = this.validateQuery(PageQuerySchema)
    const posts = await Post.paginate({ page })
    return this.json(posts)
  }

  async show() {
    const { id } = this.validateParams(PostIdParamSchema)
    const post = await Post.findOrFail(id)
    return this.json(post)
  }

  async store() {
    const data = await this.validateBody(StorePostSchema)
    const post = await Post.create(data)
    return this.created({ post })
  }
}
```

| ヘルパー | 入力元 | 非同期 | 説明 |
|--------|--------|--------|------|
| `this.validateBody(schema)` | リクエストボディ | Yes | JSON またはフォームボディをパース |
| `this.validateQuery(schema)` | クエリ文字列 | No | `?page=1&sort=desc` をパース |
| `this.validateParams(schema)` | ルートパラメータ | No | `:id`、`:slug` などをパース |

> [!TIP]
> これらのヘルパーは `safeParse()` を実装する任意のスキーマライブラリ（Zod、Valibot、カスタムバリデーター）で動作します。

### 配列形式のクエリパラメータ

同じクエリキーが繰り返された場合、スキーマには配列として渡されます。`?tag=a&tag=b` は `{ tag: ['a', 'b'] }` になります。1 回しか出現しないキーはプレーンな文字列のままなので、1 回以上出現しうるパラメータには `union` を使用してください。

```ts
const FilterQuerySchema = z.object({
  // ?tag=a&tag=b -> ['a', 'b'] / ?tag=a -> 'a'
  tag: z.union([z.string(), z.array(z.string())]).optional()
    .transform((value) => (typeof value === 'string' ? [value] : value ?? [])),
})
```

この挙動は `this.validateQuery()` と、[ルートコントラクト](./routing.md#ルートコントラクト)で付与する `query:` スキーマの両方に適用されます。

## 型安全なリクエストパース

完全な型安全性のため、リクエストパースと組み合わせます。

```ts
import { Router, parseRequestPayload, validateRequest, getValidatedData } from '@guren/core'

const schema = z.object({
  title: z.string(),
  content: z.string(),
})

const router = new Router()

router.post('/posts', async (ctx) => {
  const data = getValidatedData<z.infer<typeof schema>>(ctx)!
  // 完全に型付けされ、検証済みのデータ
  return ctx.json({ post: await Post.create(data) })
}, validateRequest(schema))
```

## コンパイル済みパース (zod 4.5+)

zod 4.5 はスキーマを高速な生成コードへコンパイルできます。`create-guren-app` で生成したアプリでは最初から有効になっており、`src/app.ts` の先頭に次のimportがあります。

```ts
import 'zod/compile'
```

このimport以降に構築されたスキーマは、自動的にコンパイル済みの経路でパースされます。Gurenのバリデーションヘルパー、ルート契約(`params`、`query`、`body`、`output`)、バリデーションミドルウェアはいずれもスキーマ自身の `parse`/`safeParse` を呼ぶため、追加の変更なしで高速化されます。

既存アプリに導入するには、`zod` の依存を `^4.5.0` へ上げ、エントリモジュールの**最初の行**として(スキーマを定義するどのモジュールよりも前に)このimportを追加してください。

Bunでの計測では、100件のリスト出力の検証が約19µsから1.2µsになり、5フィールドのボディのパースは約4倍速くなりました。エンドツーエンドでは、検証付きの100件リストを返すAPIエンドポイントのスループットが約10%向上し、レイテンシ中央値も下がりました。効果はルートの処理時間に占める検証の割合に応じて変わります。

知っておくべきことは3つです。

- **importの順序が重要です。** import前に構築されたスキーマは通常のパーサーのまま動きます。エントリモジュールの先頭に置いてください。
- **制限のあるランタイムにも対応します。** 生成コードを禁止するランタイム(厳格なCSPなど)では `z.config({ jitless: true })` を呼べばコンパイルはスキップされ、すべてそのまま動きます。未対応のスキーマ機能も通常のパーサーに静かにフォールバックし、コンパイルが例外を投げることはありません。
- **refinementは副作用なしに保ってください。** 不正な入力では `.refine()` や `.transform()` のコールバックが2回実行されることがあります(高速経路の後、完全なエラーを組み立てるフォールバックが走るため)。検証結果は変わりませんが、コールバック内の副作用は二重になります。

スキーマ非依存のバリデーションには影響しません。Valibotや自作バリデータは従来どおり自身の `parse`/`safeParse` の挙動で動きます。
