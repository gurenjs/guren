# バリデーション

Guren のバリデーションは、スキーマを先に書くやり方が基本です。Zod 互換のスキーマをコントローラー、ルートコントラクト、ミドルウェアで使い回し、どうしても必要なときだけ旧来の `FormRequest` 互換レイヤーを使います。

> **サポートする Zod バージョン:** zod 4 の API にだけ対応しています。実行時のバリデーションそのものは、`safeParse` を持つスキーマならどれでも受け付けます。ただし、スキーマの構造を読み取るツール(`guren codegen`、OpenAPI 生成、`guren context`)は、zod v3 の API(旧 `zod@3` パッケージと `zod/v3` サブパス)で書かれたスキーマを、警告を出して受け付けません。スキーマは `import { z } from 'zod'` で書いてください。

## クイックスタート

おすすめは、コントローラーのバリデーションヘルパーを使う書き方です。

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

`validateRequest()` は、バリデーション用のミドルウェアを作るファクトリです。

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

バリデーションに失敗すると、デフォルトではエラーの詳細を載せた 422 レスポンスが返ります。

### `validateRequestWith(schemaFactory)`

リクエストのコンテキストに応じてスキーマを組み立てたいときに使います。スキーマを返す関数は同期的に呼ばれるので、その中でログイン中のユーザーを await することはできません。必要な値は、`resolveIsAdmin` のように前段のミドルウェアで解決しておいてください。

```ts
import { AUTH_CONTEXT_KEY, Router, defineMiddleware, validateRequestWith } from '@guren/core'
import type { AuthContext } from '@guren/core'

const resolveIsAdmin = defineMiddleware(async (ctx, next) => {
  const auth = ctx.get(AUTH_CONTEXT_KEY) as AuthContext | undefined
  const user = await auth?.user<{ role: string }>()
  ctx.set('isAdmin', user?.role === 'admin')
  await next()
})

const router = new Router()

router.put('/users/:id', [UserController, 'update'], resolveIsAdmin, validateRequestWith((ctx) => {
  const isAdmin = ctx.get('isAdmin') === true

  return z.object({
    name: z.string().min(1),
    email: z.email(),
    // 管理者のみロール変更可能
    role: isAdmin ? z.enum(['user', 'admin']) : z.never().optional(),
  })
}))
```

## 検証済みデータの取得

バリデーションミドルウェアを通ったあとは、`getValidatedData()` で型の付いたデータを取り出せます。

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

ミドルウェアの外で検証したいときは、`validate()` か `validateSafe()` を使います。

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

`onError` を渡すと、デフォルトのエラーレスポンスを差し替えられます。

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

Guren のバリデーションは、特定のスキーマライブラリに縛られません。`ValidationSchema` を実装したオブジェクトなら、どれでも渡せます。

```ts
interface ValidationSchema<T> {
  parse(data: unknown): T
  safeParse(data: unknown): { success: true; data: T } | { success: false; error: unknown }
}
```

Zod のほか、Valibot や自作のバリデーターも使えます。

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

バリデーションに失敗したときは、デフォルトで次の形式のレスポンスが返ります。

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

Inertia のリクエスト（`X-Inertia` ヘッダー付き）で `ValidationException` が投げられた場合は、上の JSON を返しません。Laravel と同じく、エラーをセッションに flash してから、直前のページへ `303` でリダイレクトします。flash したエラーは、次にページを読み込んだときに共有 props の `errors` として渡ります。このときメッセージは、フィールドごとに 1 つずつにまとめられます。

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

この動きは、`validateBody` / `validateQuery` / `validateParams` が失敗したときにも、自分のコードで `ValidationException.withMessages(...)` を投げたときにも同じです。flash にはセッションミドルウェアが必要です（`auth` オプションを設定すれば自動でマウントされます）。挙動を変えたい場合は、サービスプロバイダで `ValidationException` 用のレンダラーを登録してください。登録したレンダラーが組み込みのものより優先されます。

### Inertia での表示

page definition に `ValidationErrors<T>` を含めておくと、コントローラーとコンポーネントで同じ型を共有できます。

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

## ルートコントラクトによる検証

`params`、`query`、`body` のスキーマを宣言したルートでは、ハンドラーが動く前に入力が検証されます。コントローラーのアクションも同じです。アクションの中でスキーマを書き直す必要はなく、パース済みの値を `this.validated()` で読み出します。

```ts
router.post('/posts', { name: 'posts.store', body: StorePostSchema }, [PostsController, 'store'])

export default class PostsController extends Controller {
  async store() {
    const { body } = this.validated('posts.store')
    const post = await Post.create(body)
    return this.created({ post })
  }
}
```

検証に失敗すると、`validateBody()` と同じ `ValidationException`(422)が同じエラーキーで投げられるので、Inertia のフォームは手を加えずにエラーを表示できます。詳しくは[検証済み入力の読み取り](./routing.md#検証済み入力の読み取り)を参照してください。

## コントローラーバリデーションヘルパー

コントローラーで検証するなら、`validateBody`、`validateQuery`、`validateParams` を使うのがいちばん手軽です。どれも `safeParse()` を持つ Zod 風のスキーマを受け取り、検証に失敗すると `ValidationException`（422）を投げます。

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
| `this.validateBody(schema)` | リクエストボディ | はい | JSON またはフォームのボディをパース |
| `this.validateQuery(schema)` | クエリ文字列 | いいえ | `?page=1&sort=desc` をパース |
| `this.validateParams(schema)` | ルートパラメータ | いいえ | `:id`、`:slug` などをパース |

> [!TIP]
> これらのヘルパーは、`safeParse()` を実装したスキーマライブラリ（Zod、Valibot、自作のバリデーター）であれば、どれとでも組み合わせられます。

### 配列形式のクエリパラメータ

同じクエリキーが繰り返されると、スキーマには配列として渡ります。たとえば `?tag=a&tag=b` は `{ tag: ['a', 'b'] }` になります。一方、1 回しか出てこないキーはただの文字列のままです。1 回のことも複数回のこともあるパラメータには、`union` を使ってください。

```ts
const FilterQuerySchema = z.object({
  // ?tag=a&tag=b -> ['a', 'b'] / ?tag=a -> 'a'
  tag: z.union([z.string(), z.array(z.string())]).optional()
    .transform((value) => (typeof value === 'string' ? [value] : value ?? [])),
})
```

この挙動は、`this.validateQuery()` にも、[ルートコントラクト](./routing.md#ルートコントラクト)で指定する `query:` スキーマにも当てはまります。

## 型安全なリクエストパース

型安全を徹底したいときは、リクエストのパースと組み合わせます。

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

zod 4.5 では、スキーマを高速な生成コードにコンパイルできます。`create-guren-app` で作ったアプリでは最初から有効で、`src/app.ts` の先頭に次の import が入っています。

```ts
import 'zod/compile'
```

この import より後に組み立てたスキーマは、コンパイル済みの経路でパースされます。Guren のバリデーションヘルパー、ルートコントラクト(`params`、`query`、`body`、`output`)、バリデーションミドルウェアは、どれもスキーマ自身の `parse`/`safeParse` を呼んでいるので、コードを書き換えなくても速くなります。

既存のアプリで使うには、`zod` の依存を `^4.5.0` に上げたうえで、エントリモジュールの**最初の行**にこの import を追加してください。スキーマを定義するどのモジュールよりも前に読み込まれる必要があります。

Bun で計測したところ、100 件のリスト出力の検証は約 19µs から 1.2µs に縮み、5 フィールドのボディのパースは約 4 倍速くなりました。エンドツーエンドでは、検証付きで 100 件のリストを返す API エンドポイントのスループットが約 10% 上がり、レイテンシの中央値も下がりました。どれだけ効くかは、ルートの処理時間のうち検証が占める割合で変わります。

注意点が 3 つあります。

- **import の順序が効きます。** import より前に組み立てたスキーマは、通常のパーサーのまま動きます。必ずエントリモジュールの先頭に置いてください。
- **制約のあるランタイムでも動きます。** 生成コードを禁止しているランタイム(厳格な CSP など)では、`z.config({ jitless: true })` を呼べばコンパイルを飛ばし、すべてそのまま動きます。対応していないスキーマ機能も通常のパーサーにフォールバックするだけで、コンパイルが例外を投げることはありません。
- **refinement には副作用を持たせないでください。** 不正な入力に対しては、`.refine()` や `.transform()` のコールバックが 2 回実行されることがあります。高速経路のあとに、完全なエラーを組み立てるためのフォールバックが走るからです。検証結果は変わりませんが、コールバック内の副作用は 2 回起きます。

zod 以外のスキーマを使ったバリデーションには影響しません。Valibot や自作のバリデーターは、これまでどおりそれぞれの `parse`/`safeParse` で動きます。
