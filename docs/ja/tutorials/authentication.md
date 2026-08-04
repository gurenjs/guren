# Part 2: 認証を追加する

[Part 1](./create-blog-post-app.md) の最後で `guren audit` が指摘したとおり、今のブログは誰でも投稿を作成・編集・削除できてしまいます。このパートでは、コマンド 1 つで認証スタック一式を追加し、投稿の変更をログイン必須にして、すべての投稿に著者を紐づけます。仕上げにもう一度 `audit` を実行し、警告が消えたことを機械に確認させます。

**このパートで学ぶこと:**

- `bunx guren add auth` が何を生成し、何を配線してくれるのか
- ミドルウェアエイリアスとルートグループでルートを保護する方法
- コントローラー内で `this.auth.userOrFail()` を使ってサインイン中のユーザーを取得する方法
- `belongsTo` リレーションシップを宣言し、`findWithOrFail` で eager load する方法
- リソースを拡張して関連データを送りつつ、`passwordHash` を決して漏らさない方法
- スキーマ変更後に `check --spec` のドリフトゲートでスペックビューを追随させる方法

## 1. 認証の雛形をインストールする

プロジェクトルートで実行します。

```bash
bunx guren add auth
```

このコマンド 1 つで、セッションベースの認証スタック一式が生成されます。主な生成物をグループで見ると:

| グループ | ファイル |
|------|---------|
| ログイン / ログアウト | `app/Http/Controllers/Auth/LoginController.ts`、`resources/js/pages/auth/Login.tsx`、`app/Http/Validators/LoginValidator.ts` |
| ユーザー登録 | `app/Http/Controllers/Auth/RegisterController.ts`、`resources/js/pages/auth/Register.tsx`、`app/Http/Validators/RegisterValidator.ts` |
| パスワードリセット | `ForgotPasswordController` / `ResetPasswordController` とページ・バリデーター、`app/Mail/PasswordResetMail.ts`、`app/Providers/MailProvider.ts`、`config/mail.ts` |
| 保護されたページの例 | `app/Http/Controllers/DashboardController.ts`、`ProfileController.ts` と対応するページ |
| モデルとプロバイダー | `app/Models/User.ts`（`AuthenticatableModel` を継承）、`app/Providers/AuthProvider.ts` |
| ルートとレイアウト | `routes/auth.ts`（`/login`、`/register`、`/forgot-password`、`/dashboard`、`/profile` など）、`resources/js/components/Layout.tsx` |
| シーダー | `db/seeders/UsersSeeder.ts` — デモユーザー（`demo@example.com` / `secret`） |

さらに **既存ファイルの編集** も行います。

- `db/schema.ts` — 初期状態の `users` テーブルを、`passwordHash` と `rememberToken` カラムを持つ定義に書き換え、対応するマイグレーションまで生成します。
- `src/app.ts` — `AuthProvider` と Mail 関連プロバイダーを登録し、`createApp()` に `auth: {}` を追加します。これによりセッションと CSRF のミドルウェアが有効になります。
- `routes/web.ts` — ルート registrar の先頭で `registerAuthRoutes(router)` をインポートして呼び出すようにします。

> [!WARNING]
> `add auth` は `db/schema.ts` の `users` テーブル定義を書き換えます。`users` にカスタムカラムを追加していた場合は、コマンド実行後に再追加してください。

users のマイグレーションは生成済みなので、適用してデモアカウントをシードします。

```bash
bun run db:migrate
bun run db:seed
bun run codegen
```

`bun run codegen` は、雛形が追加した新しいページとルートを型マニフェストに反映します（`bun run dev` が動いていれば監視が自動で実行するので、実質不要です）。生成された認証スタックの仕組み — ガード、プロバイダー、ユーザーレコードの安全な取り扱い — は[認証ガイド](../guides/authentication.md)が詳しく解説しています。

### サインイン状態をページに共有する

生成された共有レイアウト（`resources/js/components/Layout.tsx`）は、共有 props の `auth.user` を読んで **Sign in** と **Log out** を出し分けます — が、デフォルトではこの prop を共有する配線がまだありません。`app/Providers/AuthProvider.ts` に `boot()` を追加して配線します。

```ts
import { ServiceProvider, shareInertiaProps, AUTH_CONTEXT_KEY } from '@guren/core'
import type { AuthContext, AuthManager } from '@guren/core'
import { User } from '../Models/User.js'

export default class AuthProvider extends ServiceProvider {
  register(): void {
    // 生成されたままの useModel 設定はそのまま残します
    const auth = this.container.make<AuthManager>('auth')
    auth.useModel(User, {
      usernameColumn: 'email',
      passwordColumn: 'passwordHash',
      rememberTokenColumn: 'rememberToken',
      credentialsPasswordField: 'password',
    })
  }

  boot(): void {
    shareInertiaProps(async (ctx) => {
      const auth = ctx.get(AUTH_CONTEXT_KEY) as AuthContext | undefined
      return { auth: { user: await auth?.user() } }
    })
  }
}
```

`shareInertiaProps` は、すべての Inertia レスポンスの props にこの値をマージします。`auth.user()` が返すのは **サニタイズ済み** のユーザーです — `passwordHash` や `rememberToken` はランタイムで除去済みなので、丸ごと共有しても資格情報はブラウザに届きません。この配線は Part 3 のコメントフォームでも使います。

## 2. チェックポイント: サインインする

開発サーバーが動いている状態で（止めていたら `bun run dev`）、[http://localhost:3333/login](http://localhost:3333/login) を開きます。

1. **demo@example.com** / **secret** でサインインします — `/dashboard` に着地し、名前入りの挨拶が表示されます。ヘッダーのナビゲーションも **Sign in** から **Log out** に切り替わっています（先ほど配線した共有 props の効果です）。
2. 間違ったパスワードを試します — フォームに "Invalid credentials." が表示されます。
3. プライベートブラウジングのウィンドウで `/dashboard` を開きます — `/login` にリダイレクトされます。保護されたルートは本当に保護されています。

> [!NOTE]
> 雛形にはセルフ登録（`/register`）とメール経由のパスワードリセットも含まれています。このチュートリアルではシード済みのデモユーザーで進めますが、新しいアカウントを `/register` から作って試しても構いません。

## 3. 投稿の変更を保護する

`auth` ミドルウェアエイリアスを登録し、投稿を変更するルートに付与します。`routes/web.ts` を編集します。

```ts
import { Router, requireAuthenticated } from '@guren/core'
import HomeController from '../app/Http/Controllers/HomeController.js'
import PostController from '../app/Http/Controllers/PostController.js'
import { PostPayloadSchema } from '../app/Http/Validators/PostValidator.js'
import { registerAuthRoutes } from './auth.js'

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
    posts.middleware('auth').get('/:id/edit', [PostController, 'edit']).name('posts.edit')
    posts.middleware('auth').group((authed) => {
      authed.post('/', { name: 'posts.store', body: PostPayloadSchema }, [PostController, 'store'])
      authed.put('/:id', { name: 'posts.update', body: PostPayloadSchema }, [PostController, 'update'])
      authed.delete('/:id', { name: 'posts.destroy' }, [PostController, 'destroy'])
    })
  })
}
```

仕組みは 3 段構えです。

- `aliasMiddleware` はミドルウェアに一度だけ名前を付け、ルートからは `'auth'` として参照できるようにします（エイリアスは戻り値の型に記録されるので、`const router = baseRouter.aliasMiddleware(...)` と受けています）。
- 単独のルートには `.middleware('auth').get(...)` を直接チェーンします。
- まとめて保護したいルートは `.middleware('auth').group((authed) => ...)` に入れます。グループはネストできるので、`/posts` プレフィックスの内側でさらに認証だけを重ねられます。ここではルートオプション付きの 3 ルート（store / update / destroy）をこの形にしています。

投稿の一覧と閲覧は公開のまま、作成・編集・削除は未ログインの訪問者を `/login` へリダイレクトするようになりました。ミドルウェアとグループの全体像は[ルーティングガイド](../guides/routing.md)を参照してください。

次に、第 2 の防衛線としてコントローラー側にもガードを入れます。`app/Http/Controllers/PostController.ts` の store / update / destroy の先頭に 1 行追加してください。

```ts
  async store(): Promise<Response> {
    await this.auth.userOrFail()
    // ...
```

`this.auth.userOrFail()` はサインイン中のユーザーを返すか、401 で応答します。これは Part 1 で `--public` を外していれば、ジェネレーターが最初から入れていた行そのものです — ルートミドルウェアを剥がす改修が入っても、コントローラー単体で守りが残ります。`store` のこの行は、ステップ 5 で著者を設定するときに型引数付きの `userOrFail<Sanitized<UserRecord>>()` へ置き換わります。

> [!NOTE]
> ここで守ったのは「サインインしているか」（認証）だけです。今の実装では、サインイン済みユーザーなら **誰の** 投稿でも編集・削除できます。「著者本人だけが編集できる」は認可（authorization）の仕事で、Guren ではポリシーとして実装します — `bunx guren make:policy Post` で雛形が手に入り、`bunx guren make:feature` で生成する場合は `--policy` を付ければ `authorize()` の呼び出しまで組み込まれます。このシリーズでは範囲外としますが、[認可ガイド](../guides/authorization.md) が同じブログ例で解説しています。

## 4. audit で守りを確認する

```bash
bunx guren audit
```

Part 1 で出ていた 3 件の A01 警告（Mutating route has no authentication check）が消えているはずです。`audit` はルートのミドルウェアとコントローラー内の `userOrFail` の両方を認識するので、どちらか一方でも守りとして数えられますが、両方あれば多層防御になります。

## 5. すべての投稿に著者を持たせる

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
> SQLite では、すでに行が入っているテーブルに、デフォルト値のない `NOT NULL` カラムを追加できません — Part 1 で作った投稿がマイグレーションを妨げてしまいます。`db:reset --seed` はすべてのテーブルを削除し、全マイグレーションを最初から再実行して、デモユーザーを再シードします。開発データは使い捨てで構いませんが、本番データベースに対しては絶対に `db:reset` を実行しないでください。実データが相手なら、カラムを NULL 許容で追加 → 値をバックフィル → 後続のマイグレーションで NOT NULL に締める、という手順を踏みます。

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

リレーションシップ API の全体像は[データベースガイド](../guides/database.md)を参照してください。

### リソースに著者を追加する

Part 1 で読んだとおり、ブラウザに何を送るかは `PostResource` が決めます。`app/Http/Resources/PostResource.ts` を更新して著者を含めます。

```ts
import { Resource } from '@guren/core'
import type { PostAuthor, PostRecord } from '../../Models/Post.js'

type PostWithAuthor = PostRecord & { author?: PostAuthor | null }

export interface PostResourceData extends Record<string, unknown> {
  id: number
  title: string
  body: string
  author: { id: number; name: string } | null
}

export class PostResource extends Resource<PostWithAuthor> {
  toArray(): PostResourceData {
    return {
      id: this.resource.id as number,
      title: this.resource.title as string,
      body: this.resource.body as string,
      author: this.resource.author
        ? { id: this.resource.author.id, name: this.resource.author.name }
        : null,
    }
  }

  override toJSON(): PostResourceData {
    return super.toJSON() as PostResourceData
  }
}
```

これは重要な設計点です: 読み込んだ author の行には `passwordHash` が含まれており、`this.inertia()` に渡したものはすべてページにシリアライズされます。リソースが `id` と `name` だけを選んで写すので、**ユーザーレコードの残りがブラウザに転送されることはありません。** author が読み込まれていない呼び出し（一覧など）では、単に `null` になります。

### `store` で著者を設定し、`show` で読み込む

`app/Http/Controllers/PostController.ts` の 2 つのアクションを更新します。

```ts
import { Controller, paginate, type PaginatedPageProps, type Sanitized } from '@guren/core'
import type { UserRecord } from '../../Models/User.js'

// inside PostController:

  async show(): Promise<Response> {
    const { id } = this.validateParams(PostIdParamSchema)
    const post = await Post.findWithOrFail(id, 'author')

    return this.inertia(pages.posts.Show, {
      post: new PostResource(post).toJSON(),
    })
  }

  async store(): Promise<Response> {
    const user = await this.auth.userOrFail<Sanitized<UserRecord>>()
    const data = await this.validateBody(PostPayloadSchema)
    const post = await Post.create({ ...data, authorId: user.id })
    return this.redirect('/posts/' + post?.id)
  }
```

- `findWithOrFail(id, 'author')` は、投稿が見つからなければ 404 を返すその同じ呼び出しの中で、リレーションを eager load します。
- `store` は `userOrFail<Sanitized<UserRecord>>()` の戻り値から `authorId` を設定します。ブラウザに著者を選ばせないことで、なりすましを構造的に防ぎます。型引数を `UserRecord` そのままにせず `Sanitized<UserRecord>` で包むのは、ランタイムが除去する資格情報カラムを型からも消すためです（[認証ガイド](../guides/authentication.md)参照）。

### 著者を表示する

`resources/js/pages/posts/Show.tsx` に著者の行を追加します。`Props` は `PostResourceData` を参照しているので、型の変更は自動で追随します。

```tsx
      <p className="text-sm text-zinc-500">by {post.author?.name ?? 'Unknown author'}</p>
```

`PostResourceData` の形が変わったので、マニフェストを更新します: `bun run codegen`（`bun run dev` が監視中なら自動で実行されます）。

### スペックを追随させる

スキーマとモデルのリレーションシップが変わったので、Part 1 で生成した `docs/spec/` のビューは現実より古くなりました。ドリフトゲートに聞いてみましょう。

```bash
bunx guren check --spec
```

```
ERROR [fail] docs/spec/er.md: docs/spec/er.md is out of date with the code.
       → Run: bunx guren spec:generate
```

古くなったビューが `[fail]` として名指しされます — `er.md` だけでなく、認証で増えたページ・ルートを反映して `screens.md` なども並ぶはずです。言われたとおり再生成すると、`er.md` の `posts` に `authorId FK` が、`domain.md` に `author` リレーションが現れ、ゲートは緑に戻ります。

```bash
bunx guren spec:generate
bunx guren check --spec
```

「実装は変えたが仕様書の更新を忘れた」というドキュメントの宿命を、Guren は手癖ではなく機械的なゲートで防ぎます。CI に `check --spec` を置けば、古いビューはマージ自体ができません（[スペックアンカード開発](../guides/spec-anchored.md)参照）。

**チェックポイント:** [http://localhost:3333/_guren/docs](http://localhost:3333/_guren/docs) を開き直すと、ER 図の `posts` に `authorId` の外部キーが、ドメインビューに `author` リレーションシップが増えています — ビューアーは常にディスク上の最新ビューを表示します。

## 6. チェックポイント: デモユーザーとして投稿する

1. サインアウトした状態で `/posts` の **New Post** をクリックします — `/login` にリダイレクトされます。
2. **demo@example.com** / **secret** でサインインし、投稿を作成します。
3. 投稿を開きます — 署名欄に "Demo User" と表示されます。

## よくあるつまずき

**デモアカウントで "Invalid credentials." になる。**
シーダーが一度も実行されておらず、`users` テーブルが空です。`bun run db:seed` を実行してください。

**`.middleware('auth')` の `'auth'` が型エラーになる（`not assignable to parameter of type 'never'`）。**
`aliasMiddleware` の戻り値を捨てています。エイリアスは戻り値の型に記録されるので、`const router = baseRouter.aliasMiddleware('auth', ...)` と受けて、以降はその `router` を使ってください。

**`.middleware('auth').post('/', { name: ..., body: ... }, [Controller, 'store'])` が型エラーになる。**
古いリリースのフレームワークでは、ルートオプション+コントローラー指定の組み合わせをミドルウェアチェーン上で受け付けませんでした。アップグレードするか、ステップ 3 のように `.middleware('auth').group((authed) => ...)` の中で登録してください（グループ形はどのバージョンでも動きます）。

**`add_author_to_posts` マイグレーションが失敗する（`NOT NULL constraint` / カラムを追加できない）。**
`posts` の既存行が新しい `NOT NULL` カラムを満たせません。`bun run db:reset --seed` で開発用データベースを作り直してください。

**`add auth` のあと `pages.auth.Login` や `pages.dashboard.Index` が見つからない。**
codegen が新しいページをまだ認識していません。`bun run codegen` を実行するか、`bun run dev` を再起動してください。

**サインインしたのに `/posts/create` を開くたびに `/login` に戻される。**
`src/app.ts` の `createApp()` に `auth: {}` が、`providers` に `AuthProvider` が追加されているか確認してください — `add auth` が自動でパッチしますが、ファイルをカスタマイズしていた場合は要確認です。

**`Post.create` の呼び出しで TypeScript が `authorId` の欠落を指摘する。**
スキーマだけ更新してモデルを更新していません: `fillable` に `authorId` を追加し、`store` アクションがそれを渡しているか確認してください。

## 次へ

投稿に著者が付き、`audit` も静かになりました — 次は読者に声を届けてもらいましょう。[Part 3: リレーションシップ: コメント](./relationships.md) に進んでください。認証そのものを深めたい場合（ガードの種類、remember token、ユーザーレコードのサニタイズ）は[認証ガイド](../guides/authentication.md)へ。
