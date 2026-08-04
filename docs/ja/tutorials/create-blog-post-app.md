# Part 1: ブログ投稿アプリを作る

このパートではブログの心臓部 — 投稿の作成・一覧・編集・削除 — を作ります。ただし、ファイルを 1 つずつ手書きすることはしません。Guren 流の開発フローは **ジェネレーターで生成し、生成されたコードを読んで理解し、機械的なチェックで検証する** です。CRUD の縦一列（スキーマ → モデル → バリデーター → リソース → コントローラー → ルート → ページ）を、コマンド 1 つで生成するところから始めます。

**このパートで学ぶこと:**

- SQLite で新規 Guren アプリを雛形生成する方法（設定ゼロ）
- `bunx guren add resource` が生成する CRUD 一式と、自動配線されるもの
- Guren の開発ループ: **生成 → マイグレーション → codegen → check → ブラウザで確認**
- `guren context` とスペックビューで、プロジェクト知識をコードから導出する方法
- 生成コードの読み方と、各パーツのつながり
- 生成物を磨く方法: バリデーションメッセージ、エラー表示、`fillable`
- `guren audit` がセキュリティの穴をどう指摘してくれるか

> [!TIP]
> 「生成してから読む」のではなく、各レイヤーを 1 リクエスト分だけ手で辿って仕組みを深く理解したい場合は、[ファーストステップ](../guides/first-steps.md)の 10 分ツアーが最適です。このチュートリアルは実務と同じジェネレーター駆動のフローで進みます。

## 1. アプリを雛形生成する

新規プロジェクトを作成し、プロンプトに答えます。

```bash
bunx create-guren-app my-blog
```

CLI はいくつか質問をします。

- **レンダリングモード** — デフォルト（**SSR**）のままにします。
- **データベースドライバー** — デフォルト（**SQLite**、"zero-config, recommended for getting started"）のままにします。
- **Git リポジトリの初期化** — 聞かれた場合はどちらでも構いません（このチュートリアルでは使いません）。

雛形ジェネレーターがテンプレートをコピーし、すぐ使える `.env`（生成済みの `APP_KEY` と `DATABASE_URL=./data/guren.db` 入り）を書き出し、依存関係のインストールまで済ませてくれます。続けて開発サーバーを起動します。

```bash
cd my-blog
bun run dev
```

**チェックポイント:** [http://localhost:3333](http://localhost:3333) を開きます。ウェルカムページが表示されるはずです。データベースのセットアップもコンテナも不要: SQLite ファイルは必要になった時点で `./data/` 以下に作成されます。

このターミナルでは開発サーバーを動かしたままにして、以降のコマンドは別のターミナルで実行してください。

## 2. posts リソースを 1 コマンドで生成する

ここがこのチュートリアルの分岐点です。投稿機能に必要なファイルを、全部まとめて生成します。

```bash
bunx guren add resource posts --fields "title:string,body:text" --public
```

- `--fields` はカラム定義です。`名前:型` をカンマで並べ、型は `string` / `text` / `number` / `boolean` / `date` / `json` から選びます（`published:boolean?` のように `?` を付けると NULL 許容）。この 1 つの定義から、スキーマのカラム、Zod スキーマ、リソースの型、フォームの入力欄まで一貫して生成されます。
- `--public` は一時的なオプトアウトです。Guren のジェネレーターは **デフォルトで store / update / destroy にサインイン必須のガードを入れます**（セキュア・バイ・デフォルト）。本来のゴールデンパスは `add auth` → `add resource` の順で、その順なら守りは最初から組み込まれます。このシリーズはあえて逆順にして、`audit` が穴を指摘し、それを意図的に塞ぐ過程を [Part 2](./authentication.md) で見せます。

コマンドは次のファイルを生成します。

| ファイル | 役割 |
|------|---------|
| `app/Models/Post.ts` | `posts` テーブルを包む `Post` モデル |
| `app/Http/Validators/PostValidator.ts` | Zod スキーマ 3 種（ペイロード・ルートパラメータ・一覧クエリ） |
| `app/Http/Resources/PostResource.ts` | ブラウザに送るデータの形を明示する `PostResource` |
| `app/Http/Controllers/PostController.ts` | 7 アクション（index / show / create / store / edit / update / destroy） |
| `resources/js/pages/posts/Index.tsx` | 一覧ページ（ページネーション付き） |
| `resources/js/pages/posts/Show.tsx` | 詳細ページ（Edit / Delete リンク付き） |
| `resources/js/pages/posts/New.tsx` | 作成フォーム |
| `resources/js/pages/posts/Edit.tsx` | 編集フォーム |

さらに **既存ファイルの編集** も行います。

- `db/schema.ts` — `posts` テーブル定義を追記します（`id`、指定したフィールド、`createdAt`）。
- `routes/web.ts` — `/posts` のルートグループ（7 ルート、名前付き、ボディスキーマ紐づけ済み）を追記します。

生成が終わると、コマンド自身が次のステップを教えてくれます: マイグレーションを作って適用し、codegen を回す。そのとおりに進みましょう。

## 3. マイグレーションと型を生成する

```bash
bun run db:make create_posts_table
bun run db:migrate
bun run codegen
```

- `db:make` は `db/schema.ts` と既存のマイグレーションの差分を取り、新しい SQL ファイルを `db/migrations/` に書き出します。
- `db:migrate` はそれを SQLite データベースに適用します。
- `codegen` はルートとページをスキャンして、型付きマニフェストを `.guren/` に書き出します — `pages.gen.ts`（ページ名と、各コンポーネントから抽出した `Props`。`this.inertia()` が使用）と `routes.gen.ts`（ルート名とパラメータの補完が効く `route()` ヘルパー）です。これがあるからこそ、ページ名のタイポや props の渡し忘れが、実行時の事故ではなく **コンパイル時** のエラーになります。

**codegen の再実行タイミング:** ルートやページを追加・リネーム・削除したとき、またはページの `Props` を変更したときです。実際に手動で実行することはほとんどありません — `bun run dev` が起動時に codegen を実行し、開発サーバーが `routes/web.ts`、`resources/js/pages/`、`app/Http/Resources/` を監視して変更のたびに再生成するからです。エディターに古い型が表示されたときだけ、明示的にコマンドを実行してください。codegen パイプラインの全体像は[フロントエンドガイド](../guides/frontend.md)を参照してください。

## 4. 整合性をチェックする

生成・配線がすべて噛み合っているか、機械に検証させます。

```bash
bunx guren check
```

`check` はルート ↔ コントローラー ↔ ページの対応、モデルとスキーマの紐づけ、`.guren/` の生成物の存在などを検証します。ジェネレーターを使ったので、すべて `[ok]` のはずです。1 つだけ警告が出ます:

```
WARN [warn] PostController tests: No test file named after PostController ...
       → If these routes are not already covered, run: bunx guren make:test Post --controller
```

`check` は「壊れていること」だけでなく「まだ無いもの」も教えてくれます。テストはこのチュートリアルの範囲外なので今は先へ進みますが、実務では提案どおり `make:test` で骨組みを作り、[テストガイド](../guides/testing.md)のパターンで肉付けしていきます。

## 5. チェックポイント: CRUD を一周する

開発サーバーが動いている状態で（止めていたら `bun run dev`）:

1. [http://localhost:3333/posts](http://localhost:3333/posts) を開きます — 空の一覧と **New Post** ボタンが表示されます。
2. **New Post** からタイトルと本文を入力して送信します — 作成された投稿の詳細ページにリダイレクトされます。
3. **Edit** で本文を書き換えて送信します — 更新が反映されます。
4. 一覧に戻り、投稿がもう 1 件作れることも確認します。**Delete** で削除もできます（確認ダイアログ付き）。

コードを 1 行も書かずに、バリデーション・ページネーション・型付きルーティングまで揃った CRUD が動いています。では、その中身を読み解きましょう。

## 6. 全体像を導出する: context と spec

ファイルを 1 つずつ開く前に、いま生成された縦一列を俯瞰します。

```bash
bunx guren context Post
```

モデルのカラム、7 本のルート（ボディの型付き）、コントローラーのアクション、4 つのページとその `Props`、リソース — `Post` というエンティティに関わるすべてが 1 画面にまとまります。これは保存されたドキュメントではなく、実行のたびにコードから導出されるビューなので、腐ることがありません。

続けて、プロジェクト全体の要約ビューを `docs/spec/` に書き出します。

```bash
bunx guren spec:generate
```

`er.md`（テーブルと外部キー）、`domain.md`（モデルとリレーションシップ）、`screens.md`（ページとルートの対応）、`modules.md` が生成されます。これらは **コードから導出された仕様（derived）** で、コミットして残す成果物です。コードが変わればビューは古くなりますが、それを黙って放置させないためのゲートが `guren check --spec` です — Part 2 で実際にゲートが落ちるところを体験します。Guren のプロジェクト知識は、手書きで頑張るのではなく、導出（derived）・宣言（declared）・検証（checked）の 3 層で管理します。詳細は [スペックアンカード開発](../guides/spec-anchored.md) を参照してください。

**チェックポイント:** 生成したビューはブラウザーからも読めます。`bun run dev` を動かしたまま [http://localhost:3333/_guren/docs](http://localhost:3333/_guren/docs) を開いてください。4 つのスペックビューと、雛形が最初から持っている ADR（`0001-record-architecture-decisions`）が一覧に並び、`er.md` を開くと `users` と `posts` の ER 図が描画されます。各ビューには「どのコードから導出されたか」のエッジ（`db/schema.ts` → `er.md` など）が付いています。このビューアーはローカル限定・読み取り専用・開発時限定です。

## 7. 生成されたコードを読む

ジェネレーターの出力は「ブラックボックスの完成品」ではなく「読まれることを前提にした出発点」です。リクエストが流れる順に辿ります。

### スキーマ — `db/schema.ts`

```ts
export const posts = sqliteTable('posts', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  title: text('title').notNull(),
  body: text('body').notNull(),
  createdAt: text('created_at').notNull().$defaultFn(() => new Date().toISOString()),
})
```

`--fields` で指定した 2 カラムに、主キーと作成日時が足されています。ここがデータの形の唯一の源泉（source of truth）で、モデルの型も後述のマイグレーションもここから導出されます。

### モデル — `app/Models/Post.ts`

```ts
import { defineModel } from '@guren/core'
import { posts } from '../../db/schema.js'

export type PostRecord = typeof posts.$inferSelect
export type NewPostRecord = typeof posts.$inferInsert

export class Post extends defineModel(posts) {
}
```

モデルは驚くほど薄く、Drizzle のテーブルの上に Laravel スタイルの API（`find`、`create`、`paginate`、リレーションシップ）を提供します。`PostRecord` はテーブルから型推論されます — レコード型を手書きすることはありません。

### バリデーター — `app/Http/Validators/PostValidator.ts`

```ts
import { z } from 'zod'

export const PostIdParamSchema = z.object({
  id: z.coerce.number().int().positive(),
})

export const ListPostsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
})

export const PostPayloadSchema = z.object({
  title: z.string().trim().min(1),
  body: z.string().trim().min(1),
})

export type PostPayload = z.infer<typeof PostPayloadSchema>
```

リソースコントローラーが検証する 3 つの入り口（リクエストボディ・ルートパラメータ・一覧クエリ）が 1 ファイルにまとまっています。ルートパラメータやクエリ文字列は文字列として届くので、`z.coerce.number()` がバリデーション前に数値へ変換します。

### リソース — `app/Http/Resources/PostResource.ts`

```ts
export interface PostResourceData extends Record<string, unknown> {
  id: number
  title: string
  body: string
}

export class PostResource extends Resource<PostRecord> {
  toArray(): PostResourceData {
    return {
      id: this.resource.id as number,
      title: this.resource.title as string,
      body: this.resource.body as string,
    }
  }
  // ...
}
```

リソースは「ブラウザに送るフィールドを明示的に選ぶ」ための層です。モデルのレコードをそのまま `this.inertia()` に渡さず、必ずここを通すのが Guren 流です。今は列が 3 つだけなので冗長に見えますが、[Part 2](./authentication.md) でユーザー情報を扱い始めると、この層が `passwordHash` の流出を防ぐ最後の砦になります。条件付きフィールドやコレクションなど、この層の全機能は [API リソースガイド](../guides/api-resources.md)にあります。

### コントローラー — `app/Http/Controllers/PostController.ts`

7 アクションのうち、要となる 3 つを見てみましょう。

```ts
type PostsIndexProps = PaginatedPageProps<PostResourceData>

  async index(): Promise<Response> {
    const { page } = this.validateQuery(ListPostsQuerySchema)
    const result = await Post.paginate({ page, perPage: 10, orderBy: ['id', 'desc'] })
    const paginator = paginate(result, { path: this.request.path ?? '/posts' })

    return this.inertia(pages.posts.Index, {
      data: result.data.map((post) => new PostResource(post).toJSON()),
      pagination: {
        meta: paginator.meta(),
        links: paginator.links(),
      },
    } satisfies PostsIndexProps)
  }

  async show(): Promise<Response> {
    const { id } = this.validateParams(PostIdParamSchema)
    const post = await Post.findOrFail(id)

    return this.inertia(pages.posts.Show, {
      post: new PostResource(post).toJSON(),
    })
  }

  async store(): Promise<Response> {
    const data = await this.validateBody(PostPayloadSchema)
    const post = await Post.create(data)
    return this.redirect('/posts/' + post?.id)
  }
```

- **`index`** は `validateQuery` で `?page=` をバリデーションし、投稿を 1 ページ分取得して、結果を `paginate` ヘルパーで包みます。このヘルパーが、React コンポーネントで描画するページリンクを組み立てます。
- **`show`** はルートパラメータ `:id` をバリデーションし、`findOrFail` を使います。投稿が存在しなければ自動的に 404 を返すので、手動の null チェックは不要です。
- **`store`** は `validateBody` でリクエストボディをバリデーションします。失敗すると `ValidationException` が投げられ、Inertia がフィールド単位のメッセージを `form.errors` としてフォームに戻してくれます — このためのエラー処理コードを書く必要はありません。
- **`pages.posts.Index`** はステップ 3 で見た生成マニフェスト由来です。codegen 前はエディターがエラーを出しますが、それで正常です。

### ルート — `routes/web.ts`

```ts
  router.group('/posts', (posts) => {
    posts.get('/', [PostController, 'index']).name('posts.index')
    posts.get('/create', [PostController, 'create']).name('posts.create')
    posts.get('/:id', [PostController, 'show']).name('posts.show')
    posts.get('/:id/edit', [PostController, 'edit']).name('posts.edit')
    posts.post('/', { name: 'posts.store', body: PostPayloadSchema }, [PostController, 'store'])
    posts.put('/:id', { name: 'posts.update', body: PostPayloadSchema }, [PostController, 'update'])
    posts.delete('/:id', { name: 'posts.destroy' }, [PostController, 'destroy'])
  })
```

- すべてのルートに `.name()`（または `name` オプション）が付いています。これにより、ページ側で URL をハードコードする代わりに、型付きの `route()` ヘルパーでリンクできます。
- `body: PostPayloadSchema` オプションは Zod スキーマをルートコントラクトに紐づけます。これで codegen がフロントエンド向けに型付きのリクエストボディを生成できます。
- `/create` は `/:id` より **先に** 登録されています。ルートは上から順にマッチするため、`/:id` が先にあると `/posts/create` は `"create"` を id として解釈しようとしてしまいます。ジェネレーターはこの順序を守って配線します。グループ・名前付きルート・モデルバインディングの全体像は[ルーティングガイド](../guides/routing.md)を参照してください。

### ページ — `resources/js/pages/posts/New.tsx`

```tsx
import { useForm } from '@inertiajs/react'
import type { ApiRoutes } from '@/.guren/api-client.gen'
import type { RouteBody } from '@guren/inertia-client/typed-forms'
import { route } from '@/.guren/routes.gen'

type PostFormData = RouteBody<ApiRoutes, 'posts.store'>

export default function NewPost() {
  const form = useForm<PostFormData>({ title: '', body: '' })
  return (
    <main className="mx-auto max-w-3xl px-6 py-12">
      <form className="space-y-4" onSubmit={(submitEvent) => { submitEvent.preventDefault(); form.post(route('posts.store')) }}>
        <input value={form.data.title} onChange={(event) => form.setData('title', event.target.value)} placeholder="title" className="w-full rounded border px-3 py-2" />
        <textarea value={form.data.body} onChange={(event) => form.setData('body', event.target.value)} placeholder="body" className="w-full rounded border px-3 py-2" />
        <button type="submit" className="rounded bg-black px-4 py-2 text-white">Create</button>
      </form>
    </main>
  )
}
```

- Inertia ページは `resources/js/pages/` 以下に置く普通の React コンポーネントです。ディレクトリパスがそのままページ名になります: `posts/New.tsx` は `pages.posts.New` です（URL は `/posts/create`、ルート名は `posts.create` — ファイル名とルート名は独立しています）。
- `RouteBody<ApiRoutes, 'posts.store'>` に注目してください。フォームのデータ型を手書きせず、**ルートに紐づけた Zod スキーマから逆算**しています。サーバー側で `PostPayloadSchema` にフィールドを足せば、フォーム側の型も追随します。
- `useForm` は送信ライフサイクル全体を面倒みてくれます: `form.post()` がデータを送信し、サーバーがバリデーションで拒否したときは `form.errors` にメッセージが入ります。

## 8. 生成物を磨く: エラーメッセージを表示する

今のフォームは、バリデーションに失敗しても何も表示しません — エラーは `form.errors` に届いているのに、描画していないからです。

まず `app/Http/Validators/PostValidator.ts` のメッセージを人間向けにします。

```ts
export const PostPayloadSchema = z.object({
  title: z.string().trim().min(1, 'Title is required.'),
  body: z.string().trim().min(1, 'Body is required.'),
})
```

次に `resources/js/pages/posts/New.tsx` の各入力欄の下にエラー表示を追加します。

```tsx
        <input value={form.data.title} onChange={(event) => form.setData('title', event.target.value)} placeholder="title" className="w-full rounded border px-3 py-2" />
        {form.errors.title && <p className="text-sm text-red-600">{form.errors.title}</p>}
        <textarea value={form.data.body} onChange={(event) => form.setData('body', event.target.value)} placeholder="body" className="w-full rounded border px-3 py-2" />
        {form.errors.body && <p className="text-sm text-red-600">{form.errors.body}</p>}
```

`Edit.tsx` にも同じ 2 行を足してください。この 422 → `form.errors` の往復の仕組みは[バリデーションガイド](../guides/validation.md)が仕様として定義しています。

**チェックポイント:** `/posts/create` で両方のフィールドを **空のまま** 送信します — ページは遷移せず、入力欄の下に "Title is required." が表示されます。これはあなたの Zod スキーマの声です。サーバーでのバリデーション失敗が `form.errors` まで往復してきました。

## 9. セキュリティ監査を実行する

最後に、Guren にこのアプリの守りを点検させます。

```bash
bunx guren audit
```

2 種類の警告に注目してください。

```
WARN [warn] [A01] POST /posts: Mutating route has no authentication check (PostController.store).
WARN [warn] [A01] PUT /posts/:id: Mutating route has no authentication check (PostController.update).
WARN [warn] [A01] DELETE /posts/:id: Mutating route has no authentication check (PostController.destroy).
WARN [warn] [API3] Post mass assignment: Post declares no fillable — all columns except 'id' are mass-assignable.
```

- **A01** は、私たちが `--public` で意図的に開けた穴です。`audit` はそれを忘れずに指摘し続けてくれます — 「あとで認証を付けるつもりだった」が「付け忘れた」にならないように。[Part 2](./authentication.md) で認証を導入して解消します。
- **API3** は今すぐ直せます。`app/Models/Post.ts` にマスアサインメントの許可リストを宣言しましょう。

```ts
export class Post extends defineModel(posts) {
  static fillable = ['title', 'body']
}
```

`fillable` を設定すると、許可リスト外のフィールドを `Post.create()` や `Post.update()` に渡した場合に `MassAssignmentException` がスローされ、バグやインジェクションの試みが黙って破棄されることなく即座に表面化します。もう一度 `bunx guren audit` を実行すると、API3 の警告が消えています。詳細は[データベースガイド](../guides/database.md)を参照してください。

これが Guren の開発ループの全体像です: **生成 → マイグレーション → codegen → check → 動作確認 → audit**。スキーマを変えたときは `spec:generate` でスペックビューも追随させます（サボると `check --spec` が止めてくれます — Part 2 で体験します）。この後のパートでも、同じループを回し続けます。

## よくあるつまずき

**`Cannot find module '.guren/pages.gen'`、または `pages.posts.Index` が存在しない。**
ルートとページを追加してから codegen が実行されていません。`bun run codegen` を実行してください（または `bun run dev` を再起動）。

**`/posts` を開くと `no such table: posts`。**
マイグレーションが生成されていないか、適用されていません。`bun run db:make create_posts_table` に続けて `bun run db:migrate` を実行してください。

**`bun run db:migrate` が "cannot connect to the database" で失敗する。**
雛形生成のときに SQLite ではなく PostgreSQL / MySQL を選んでいます。先に `bun run db:up` でコンテナを起動してください。詳しくは[トラブルシューティング](../guides/troubleshoot.md)を参照してください。

**フォームを送信すると 401 が返る、またはリダイレクトされて何も起きない。**
`--public` を省略して生成しています。その場合の store / update / destroy には `this.auth.userOrFail()` のガードが入っており、認証を導入するまでは常に失敗します。まだファイルに手を入れていなければ `--force --public` で生成し直すのが確実です（編集済みなら、認証を入れる Part 2 までガード行を一時的に外す手もあります）。

**フォームを送信しても何も起きない（エラーも出ない）。**
バリデーションで拒否されています。ステップ 8 のエラー表示（`form.errors.title` / `form.errors.body`）を追加したか確認してください — メッセージは届いているのに、表示していないだけです。

**props を変更したあと `this.inertia(pages.posts.Index, ...)` で型エラー。**
ページマニフェストが古くなっています。`bun run codegen` を再実行して、抽出済みの `Props` をコントローラーの送信内容に合わせてください。

**雛形生成時に `Directory "my-blog" is not empty`。**
別の新しいディレクトリ名を選ぶか、`--force` を渡して強制的に生成してください。

## 次へ

`guren audit` が指摘したとおり、今のままでは誰でも投稿を作成・編集・削除できてしまいます。[Part 2: 認証を追加する](./authentication.md) で直しましょう。
