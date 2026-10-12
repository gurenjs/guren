# バリデーション

リクエストの入力をスキーマで検証し、型の付いたパース済みの値を受け取ります。入力が不正なときは 422 のレスポンスを返して終わります。Inertia のリクエストなら、フィールドごとのエラーメッセージを付けてフォームへリダイレクトします。

スキーマは zod 4 で書きます（`import { z } from 'zod'`）。検証そのものは `safeParse()` を持つスキーマならどれでも受け付けます。ただし `guren codegen`、OpenAPI 生成、`guren context` はスキーマの構造を読み取るので、zod v3 の API（`zod@3` パッケージや `zod/v3` サブパス）で書いたスキーマは警告を出して読み飛ばします。

## 検証する場所の選び方

| 場所 | 使う場面 | 値の受け取り方 |
|------|----------|----------------|
| [コントローラーのヘルパー](#コントローラーバリデーションヘルパー) | 通常はこれ。コントローラーのアクションの中で検証する | `this.validateBody()` などの戻り値 |
| [ルートコントラクト](#ルートコントラクトによる検証) | ルートの型を codegen、OpenAPI、エージェントのツールにも渡したい | `this.validated('route.name')` |
| [ミドルウェア](#ミドルウェアバリデーション) | ハンドラーがコントローラーのアクションではなく、インラインの関数である | `getValidatedData(ctx)` |
| [`validate()` / `validateSafe()`](#手動バリデーション) | 検証するデータがリクエストから来ない（ジョブ、コンソールコマンド、スクリプト） | 戻り値 |

Laravel から移行したコード向けに、クラスで書く `FormRequest` の層も残っています。非推奨なので、新しく書く検証には上の 4 つのどれかを使ってください。

## クイックスタート

アクションの先頭でヘルパーを呼びます。戻り値はパース済みの値なので、下の `data` には `{ title: string; content: string }` の型が付きます。

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

ボディが `StorePostSchema` を満たさないと、`validateBody()` が `ValidationException` を投げてアクションはそこで止まります。この例外を自分で catch する必要はありません。フレームワークが[フォームバリデーションエラー](#フォームバリデーションエラー)で説明するレスポンスに変えて返します。

## コントローラーバリデーションヘルパー

ヘルパーはそれぞれ、リクエストの決まった部分を読みます。

| ヘルパー | 入力元 | 非同期 | 失敗したとき |
|----------|--------|--------|--------------|
| `this.validateBody(schema)` | JSON またはフォームのボディ | はい | `ValidationException`（422）を投げる |
| `this.validateQuery(schema)` | クエリ文字列（`?page=1&sort=desc`） | いいえ | `ValidationException`（422）を投げる |
| `this.validateParams(schema)` | ルートパラメータ（`:id`、`:slug`） | いいえ | `ValidationException`（422）を投げる |
| `this.validateBodySafe(schema)` | JSON またはフォームのボディ | はい | `{ success: false, errors }` を返す |
| `this.validateQuerySafe(schema)` | クエリ文字列 | いいえ | `{ success: false, errors }` を返す |
| `this.validateParamsSafe(schema)` | ルートパラメータ | いいえ | `{ success: false, errors }` を返す |

エラーの扱いをアクションの中で決めたいときは、`Safe` の付いた版を使います（[Inertia での表示](#inertia-での表示)の例を参照）。成功したときの戻り値は `{ success: true, data }` です。

ルートパラメータは文字列で届くので、スキーマの側で型を変換します。

```ts
const PostIdParamSchema = z.object({
  id: z.coerce.number().int().positive(),
})

export default class PostsController extends Controller {
  async show() {
    const { id } = this.validateParams(PostIdParamSchema)
    const post = await Post.findOrFail(id)
    return this.json(post)
  }
}
```

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

検証に失敗すると、`validateBody()` と同じ `ValidationException`（422）が同じエラーキーで投げられるので、Inertia のフォームは手を加えずにエラーを表示できます。詳しくは[検証済み入力の読み取り](./routing.md#検証済み入力の読み取り)を参照してください。

## フォームバリデーションエラー

`ValidationException` が投げられたときにクライアントが受け取る内容は、リクエストの種類で変わります。

### JSON リクエスト

JSON や API のリクエストには、422 とともにフィールドごとのメッセージをすべて返します。キーはフィールドのパスです。

```json
{
  "message": "The given data was invalid.",
  "errors": {
    "email": ["Invalid email address"],
    "password": ["Too small: expected string to have >=8 characters"]
  }
}
```

### Inertia リクエストの自動ハンドリング

Inertia のリクエスト（`X-Inertia` ヘッダー付き）には JSON を返さず、Laravel と同じように次の順で処理します。

1. エラーをセッションに flash（次のリクエストまで一度だけ保持）します。
2. 直前のページへ `303` でリダイレクトします。
3. そのページを読み込むと、エラーが共有 props の `errors` に入ります。メッセージはフィールドごとに 1 つです。

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

`validateBody`、`validateQuery`、`validateParams`、ルートコントラクトの失敗にも、自分のコードで投げた `ValidationException.withMessages(...)` にも、同じ処理が適用されます。

flash にはセッションミドルウェアが必要で、`auth` オプションを設定すれば自動でマウントされます。挙動を変えたい場合は、サービスプロバイダで `ValidationException` 用のレンダラーを登録してください。登録したレンダラーが組み込みのものより優先されます。

### Inertia での表示

リダイレクトせずに同じレスポンスでエラーを表示したいときは、`Safe` の付いたヘルパーを使い、戻り値の `errors` をページに渡します。prop の型を `ValidationErrors<T>` にしておくと、コントローラーとコンポーネントで同じエラーの型を共有できます。

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

## ミドルウェアバリデーション

### `validateRequest(schema)`

`validateRequest()` は、ハンドラーより前にリクエストボディを検証するミドルウェアを作ります。ハンドラーでは、パース済みのボディを `getValidatedData()` で取り出します。

```ts
import { Router, getValidatedData, validateRequest } from '@guren/core'
import { z } from 'zod'

const CreatePostSchema = z.object({
  title: z.string().min(1),
  content: z.string().min(1),
})

const router = new Router()

router.post('/posts', async (ctx) => {
  const data = getValidatedData<z.infer<typeof CreatePostSchema>>(ctx)!
  return ctx.json({ post: await Post.create(data) })
}, validateRequest(CreatePostSchema))
```

ミドルウェアがそのルートで動いていなければ `getValidatedData()` は `undefined` を返すので、例では `!` を付けています。

検証に失敗すると、ミドルウェアがその場で 422 を返します。中身はトップレベルのフィールドごとに最初のメッセージ 1 つです。

```json
{
  "errors": {
    "title": "Too small: expected string to have >=1 characters"
  }
}
```

### `validateRequestWith(schemaFactory)`

リクエストに応じてスキーマを組み立てたいときに使います。スキーマを返す関数は同期的に呼ばれるので、その中でログイン中のユーザーを await することはできません。必要な値は、`resolveIsAdmin` のように前段のミドルウェアで解決しておいてください。

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

### カスタムエラーハンドリング

どちらのミドルウェアも `onError` オプションを受け取り、422 のレスポンスを差し替えられます。引数には、フィールド名からメッセージへの同じ対応表が渡ります。

```ts
validateRequest(schema, {
  onError: (ctx, errors) => {
    return ctx.json({
      message: 'バリデーションに失敗しました',
      errors: Object.entries(errors).map(([field, message]) => ({ field, message })),
    }, 422)
  },
})
```

ステータスだけを変えたいなら `status` を、どのフィールドにも結び付かないエラーのメッセージを変えたいなら `fallbackMessage` を指定します。

## 手動バリデーション

リクエストから来ないデータは、`validate()` か `validateSafe()` で検証します。

```ts
import { validate, validateSafe } from '@guren/core'

// パース済みのデータを返す。失敗するとスキーマ自身のエラー（zod なら ZodError）を投げる
const data = validate(schema, input)

// 例外は投げない
const result = validateSafe(schema, input)
if (result.success) {
  console.log(result.data)
} else {
  console.log(result.errors) // { field: '最初のメッセージ' }
}
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

## スキーマインターフェース

バリデーションは Zod に依存していません。ミドルウェアと `validate()` は次の形を持つオブジェクトならどれでも受け付け、コントローラーのヘルパーは `safeParse()` だけを使います。

```ts
interface ValidationSchema<T> {
  parse(data: unknown): T
  safeParse(data: unknown): { success: true; data: T } | { success: false; error: unknown }
}
```

たとえば Valibot のスキーマも渡せます。

```ts
import * as v from 'valibot'
import { Router, validateRequest } from '@guren/core'

const schema = v.object({
  name: v.string([v.minLength(1)]),
  email: v.string([v.email()]),
})

const router = new Router()

router.post('/users', handler, validateRequest(schema))
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
