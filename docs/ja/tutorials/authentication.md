# Part 2: 認証を追加する

[Part 1](./create-blog-post-app.md) で作ったブログは、誰でも投稿を公開できてしまいます。このパートでは、コマンド 1 つでユーザーアカウントを追加し、投稿作成をログイン必須にして、すべての投稿に著者を紐づけます。

**このパートで学ぶこと:**

- `bunx guren add auth` が何を生成し、何を配線してくれるのか
- ミドルウェアエイリアスとルートグループでルートを保護する方法
- コントローラー内で `this.auth.userOrFail()` を使ってサインイン中のユーザーを取得する方法
- `belongsTo` リレーションシップを宣言し、`findWithOrFail` で eager load する方法

## 1. 認証の雛形をインストールする

プロジェクトルートで実行します。

```bash
bunx guren add auth
```

このコマンド 1 つで、セッションベースのログインスタック一式が生成されます。

| ファイル | 役割 |
|------|---------|
| `app/Http/Controllers/Auth/LoginController.ts` | ログインフォーム、サインイン（`auth.attempt`）、ログアウト |
| `app/Http/Controllers/DashboardController.ts` | 保護されたページの例 |
| `app/Http/Controllers/ProfileController.ts` | 名前 / メールアドレス / パスワードの編集 |
| `app/Models/User.ts` | `AuthenticatableModel` を継承した `User` モデル |
| `app/Providers/AuthProvider.ts` | 認証マネージャーに `User` で認証するよう指示 |
| `app/Http/Validators/LoginValidator.ts` | ログインフォーム用の Zod スキーマ |
| `app/Http/Validators/ProfileValidator.ts` | プロフィール更新用の Zod スキーマ |
| `resources/js/components/Layout.tsx` | サインイン / ログアウトのナビゲーション付き共有レイアウト |
| `resources/js/pages/auth/Login.tsx` | ログインページ |
| `resources/js/pages/dashboard/Index.tsx` | ダッシュボードページ |
| `resources/js/pages/profile/Edit.tsx` | プロフィールページ |
| `routes/auth.ts` | `registerAuthRoutes()` — `/login`、`/logout`、`/dashboard`、`/profile` |
| `db/seeders/UsersSeeder.ts` | デモユーザー（`demo@example.com` / `secret`）をシード |

さらに **既存ファイルの編集** も行います。

- `db/schema.ts` — 初期状態の `users` テーブルを、`passwordHash` と `rememberToken` カラムを持つものに置き換え（引き続き SQLite）、対応するマイグレーションを生成します。
- `src/app.ts` — `AuthProvider` を登録し、`createApp()` に `auth: {}` を追加します。これによりセッションと CSRF のミドルウェアが有効になります。
- `routes/web.ts` — ルート registrar の先頭で `registerAuthRoutes(router)` をインポートして呼び出すようにします。

> [!WARNING]
> `add auth` は `db/schema.ts` の `users` テーブル定義を書き換えます。`users` にカスタムカラムを追加していた場合は、コマンド実行後に再追加してください。

続いて、users のマイグレーションを適用し、デモアカウントをシードし、生成済みの型を更新します（雛形が新しいページとルートを追加したためです）。

```bash
bun run db:migrate
bun run db:seed
bun run codegen
```

## 2. チェックポイント: サインインする

開発サーバーを起動し（`bun run dev`）、[http://localhost:3333/login](http://localhost:3333/login) を開きます。

1. **demo@example.com** / **secret** でサインインします — `/dashboard` に着地し、名前入りの挨拶が表示されます。
2. 間違ったパスワードを試します — フォームに "Invalid credentials." が表示されます。
3. プライベートブラウジングのウィンドウで `/dashboard` を開きます — `/login` にリダイレクトされます。保護されたルートは本当に保護されています。

> [!NOTE]
> 雛形が提供するのはログインフローであり、一般公開のセルフ登録機能ではありません。開発中にユーザーを増やしたい場合は、`db/seeders/UsersSeeder.ts` にエントリーを追加して `bun run db:seed` を再実行してください。

## 3. 投稿作成を保護する

`auth` ミドルウェアエイリアスを登録し、投稿を変更する 2 つのルートに付与します。

`routes/web.ts` を編集します。

```ts
import { Router, requireAuthenticated } from '@guren/core'
import { registerAuthRoutes } from './auth.js'
import HomeController from '../app/Http/Controllers/HomeController.js'
import PostController from '../app/Http/Controllers/PostController.js'
import { PostPayloadSchema } from '../app/Http/Validators/PostValidator.js'

export function registerWebRoutes(baseRouter: Router): void {
  const router = baseRouter.aliasMiddleware('auth', requireAuthenticated({ redirectTo: '/login' }))

  registerAuthRoutes(router)

  router.get('/', [HomeController, 'index'])

  // Health check endpoint for load balancers and uptime monitors
  router.get('/health', (c) => c.json({ status: 'ok' }))

  router.group('/posts', (posts) => {
    posts.get('/', [PostController, 'index']).name('posts.index')
    posts.middleware('auth').get('/create', [PostController, 'create']).name('posts.create')
    posts.get('/:id', [PostController, 'show']).name('posts.show')
    posts.middleware('auth').post('/', { name: 'posts.store', body: PostPayloadSchema }, [PostController, 'store'])
  })
}
```

`aliasMiddleware` はミドルウェアに一度だけ名前を付け、ルートからは `'auth'` として参照できるようにします。戻り値はエイリアス名を型に載せた新しい `Router` なので、`const router = baseRouter.aliasMiddleware(...)` のように必ず受け取ってください（受け取らないと後続の `.middleware('auth')` が型エラーになります）。投稿の一覧と閲覧は公開のまま、`/posts/create` と `POST /posts` の送信は、未ログインの訪問者を `/login` にリダイレクトするようになりました。保護したいルートが複数あるなら、1 つずつタグ付けする代わりにグループでまとめられます。

```ts
posts.middleware('auth').group((authed) => {
  authed.get('/create', [PostController, 'create']).name('posts.create')
  authed.post('/', { name: 'posts.store', body: PostPayloadSchema }, [PostController, 'store'])
})
```

## 4. すべての投稿に著者を持たせる

### カラムを追加する

`db/schema.ts` の `posts` テーブルを編集し、`users` を参照させます。

```ts
export const posts = sqliteTable('posts', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  title: text('title').notNull(),
  body: text('body').notNull(),
  authorId: integer('author_id').notNull().references(() => users.id),
  createdAt: text('created_at').notNull().$defaultFn(() => new Date().toISOString()),
})
```

マイグレーションを生成し、開発用データベースを作り直します。

```bash
bun run db:make add_author_to_posts
bun run db:reset --seed
```

> [!WARNING]
> SQLite では、すでに行が入っているテーブルに、デフォルト値のない `NOT NULL` カラムを追加できません — Part 1 で作った投稿がマイグレーションを妨げてしまいます。`db:reset --seed` はすべてのテーブルを削除し、全マイグレーションを最初から再実行して、デモユーザーを再シードします。開発データは使い捨てで構いませんが、本番データベースに対しては絶対に `db:reset` を実行しないでください。

### リレーションシップを宣言する

`app/Models/Post.ts` を更新し、投稿が著者に属することを宣言します。

```ts
import { defineModel, type BelongsToRecord } from '@guren/core'
import { posts } from '../../db/schema.js'
import type { UserRecord } from './User.js'

export type PostRecord = typeof posts.$inferSelect
export type NewPostRecord = typeof posts.$inferInsert
export type PostAuthor = Pick<UserRecord, 'id' | 'name'>

export class Post extends defineModel(posts) {
  static fillable = ['title', 'body', 'authorId']

  static override relationTypes: { author: BelongsToRecord<PostAuthor> } = {
    author: null,
  }
}

Post.belongsTo('author', () => import('./User.js').then((m) => m.User), 'authorId', 'id')
```

ここでは 3 つの要素が連携しています。

- `Post.belongsTo('author', ...)` がリレーションを登録します: `posts.authorId` をたどって `users.id` に到達する、という意味です。遅延 `import()` により、`Post` と `User` の循環インポートを回避しています。
- `relationTypes` は、eager load されたデータの形を TypeScript に伝えます — `post.author` は `PostAuthor | null` と型付けされます。
- `authorId` を `fillable` に加えることで、`Post.create()` がこのフィールドを設定できるようになります。

### `store` で著者を設定し、`show` で読み込む

`app/Http/Controllers/PostController.ts` の 2 つのアクションを更新します。

```ts
import type { UserRecord } from '../../Models/User.js'

// inside PostController:

  async show(): Promise<Response> {
    const { id } = this.validateParams(PostIdParamSchema)
    const post = await Post.findWithOrFail(id, 'author')

    return this.inertia(pages.posts.Show, {
      post: {
        id: post.id,
        title: post.title,
        body: post.body,
        createdAt: post.createdAt,
        author: post.author ? { id: post.author.id, name: post.author.name } : null,
      },
    })
  }

  async store(): Promise<Response> {
    const data = await this.validateBody(PostPayloadSchema)
    const user = await this.auth.userOrFail<UserRecord>()
    const post = await Post.create({ ...data, authorId: user.id })

    return this.redirect(post ? `/posts/${post.id}` : '/posts')
  }
```

- `this.auth.userOrFail()` はサインイン中のユーザーを返すか、401 で応答します — ルートミドルウェアの背後に置く第 2 の防衛線です。
- `findWithOrFail(id, 'author')` は、投稿が見つからなければ 404 を返すその同じ呼び出しの中で、リレーションを eager load します。
- `show` アクションは、生のレコードをそのまま渡すのではなく、明示的なペイロードを組み立てています。これは重要です: 読み込んだ author の行には `passwordHash` が含まれており、`this.inertia()` に渡したものはすべてページにシリアライズされます。**送るフィールドは自分で選んでください。ユーザーレコードを丸ごとブラウザに転送してはいけません。**

### 著者を表示する

`resources/js/pages/posts/Show.tsx` の `Props` とヘッダー部分を更新します。

```tsx
interface Props {
  post: {
    id: number
    title: string
    body: string
    createdAt: string
    author: { id: number; name: string } | null
  }
}
```

```tsx
      <p className="text-sm text-zinc-500">
        {new Date(post.createdAt).toLocaleDateString()} · {post.author?.name ?? 'Unknown author'}
      </p>
```

`Props` の形が変わったので、マニフェストを更新します: `bun run codegen`（`bun run dev` が監視中なら自動で実行されます）。

## 5. チェックポイント: デモユーザーとして投稿する

1. サインアウトした状態で `/posts` の **New post** をクリックします — `/login` にリダイレクトされます。
2. **demo@example.com** / **secret** でサインインし、投稿を作成します。
3. 投稿を開きます — 署名欄に "Demo User" と表示されます。

## よくあるつまずき

**デモアカウントで "Invalid credentials." になる。**
シーダーが一度も実行されておらず、`users` テーブルが空です。`bun run db:seed` を実行してください。

**`add_author_to_posts` マイグレーションが失敗する（`NOT NULL constraint` / カラムを追加できない）。**
`posts` の既存行が新しい `NOT NULL` カラムを満たせません。`bun run db:reset --seed` で開発用データベースを作り直してください。

**`add auth` のあと `pages.auth.Login` や `pages.dashboard.Index` が見つからない。**
codegen が新しいページをまだ認識していません。`bun run codegen` を実行するか、`bun run dev` を再起動してください。

**サインインしたのに `/posts/create` を開くたびに `/login` に戻される。**
`src/app.ts` の `createApp()` に `auth: {}` が、`providers` に `AuthProvider` が追加されているか確認してください — `add auth` が自動でパッチしますが、ファイルをカスタマイズしていた場合は要確認です。

**`Post.create` の呼び出しで TypeScript が `authorId` の欠落を指摘する。**
スキーマだけ更新してモデルを更新していません: `fillable` に `authorId` を追加し、`store` アクションがそれを渡しているか確認してください。

## 次へ

投稿に著者が付きました — 次は読者に声を届けてもらいましょう。[Part 3: リレーションシップ: コメント](./relationships.md) に進んでください。
