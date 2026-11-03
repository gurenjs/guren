# モデル

モデルは、`db/schema.ts` のテーブル 1 つに対応します。モデルを通してテーブルを検索し、行を作成・更新し、レコードのキャスト、シリアライズ、ページネーションの方法も決めます。接続とスキーマの準備は[データベース](./database.md)で、モデル同士のリレーションは[リレーション](./relationships.md)で説明します。

## モデルの定義

`defineModel()` を使うと、Drizzle のテーブルから型付きのモデルを直接作れます。

```ts
// app/Models/Post.ts
import { defineModel } from '@guren/core'
import { posts } from '@/db/schema'

export type PostRecord = typeof posts.$inferSelect
export type NewPostRecord = typeof posts.$inferInsert

export class Post extends defineModel(posts) {}
```

これだけで、`Post` には `find`、`create`、`where`、`paginate` をはじめとする多くのメソッドがそろいます。

### create のペイロードを整える

`defineModel()` が `create()` 用に推論する型では、データベース側にデフォルト値の無いカラムがすべて必須になります。値をモデル自身が作るカラムがある場合は、型を手で書かずに、同じ `defineModel()` の呼び出しで指定してください。

```ts
export class User extends defineModel(users, {
  base: AuthenticatableModel,
  optionalOnCreate: ['passwordHash'],  // password から生成するので渡さなくてよい
  requireOnCreate: ['password'],     // 代わりに仮想フィールドを必須にする
}) {}
```

`optionalOnCreate` はカラムを任意にします(型は変わらず、渡さなくてもよくなります)。`requireOnCreate` は反対にフィールドを必須にします。指定できるのは、テーブルのカラム(Drizzle はデフォルト値のあるカラムを任意にします)と、`base` が持つフィールドです。どちらも型の上だけの指定ですが、実際のキーと照合されるので、打ち間違いはコンパイルエラーになります。

どちらを指定しても、ペイロードに入れられるキーが限定されるわけではありません。create の型は知らないキーも `unknown` として受け入れるので、意図しないフィールドは、これまでどおり実行時に `fillable` で弾きます。

## データの取得

まずは簡単なものから始めます。

```ts
// すべて取得
const allPosts = await Post.all()

// 主キーで検索
const post = await Post.find(1)          // 見つからなければ null
const post = await Post.findOrFail(1)    // 見つからなければ ModelNotFoundException（404）を投げる

// 条件に合う最初のレコード
const latest = await Post.first()
```

### Fluent クエリビルダー

条件、並び順、件数の制限をつなげて、もっと複雑なクエリを書けます。

```ts
const published = await Post.where('status', 'published').get()

const trending = await Post.where('status', 'published')
  .where('views', '>', 100)
  .orWhere('featured', true)
  .orderBy('createdAt', 'desc')
  .limit(10)
  .get()

// 単純な等値比較はオブジェクトで書ける
const drafts = await Post.where({ status: 'draft', authorId: 1 }).get()

// コールバックで条件を括弧にまとめる:
// (title LIKE ? OR excerpt LIKE ?) AND status = 'published'
const hits = await Post.where((q) => {
  q.where('title', 'like', '%bun%').orWhere('excerpt', 'like', '%bun%')
})
  .where('status', 'published')
  .get()
```

> [!TIP]
> QueryBuilder は thenable なので、`.get()` を呼ばずにそのまま `await` できます。`await Post.where({ status: 'draft' })` と `await Post.where({ status: 'draft' }).get()` は同じ結果になります。

| メソッド | 説明 |
|--------|-------------|
| `.where(column, value)` | 等値でフィルタ |
| `.where(column, operator, value)` | 演算子でフィルタ（`'='`、`'!='`、`'>'`、`'<'`、`'>='`、`'<='`、`'like'`、`'in'`、`'not in'`、`'is null'`、`'is not null'`） |
| `.where(object)` | 複数の等値条件でフィルタ |
| `.where(callback)` | 括弧でグループ化した条件を AND で結合 |
| `.orWhere(column, value)` | OR 条件 |
| `.orWhere(column, operator, value)` | 演算子付き OR 条件 |
| `.orWhere(callback)` | 括弧でグループ化した条件を OR で結合 |
| `.orderBy(column, direction?)` | 結果をソート(`'asc'` または `'desc'`) |
| `.limit(n)` | 結果件数を制限 |
| `.offset(n)` | 最初の n 件をスキップ |
| `.get()` | クエリを実行して結果の配列を返す |
| `.first()` | クエリを実行して最初の結果または null を返す |
| `.count()` | マッチするレコードの件数を返す |
| `.sum(column)` / `.avg(column)` | マッチするレコードの列の合計・平均を返す |
| `.min(column)` / `.max(column)` | 列の最小値・最大値を返す |
| `.exists()` | マッチするレコードがあるかを返す |
| `.toDrizzle(query?)` | モデルの条件とスコープを持った Drizzle の select を返す |

### 集計

```ts
const revenue = await Order.where('status', 'paid').sum('total')
const averageViews = await Post.where('status', 'published').avg('views')
const newest = await Post.newQuery().max('createdAt')
const hasDrafts = await Post.where('status', 'draft').exists()
```

集計にも、モデルの[グローバルスコープ](#グローバルスコープ)が適用されます。[`SoftDeletes`](#ソフトデリート) を使うモデルでは、`get()` と同じように、ゴミ箱に入った行は合計に含まれません。

戻り値の型は列の型で決まります。合計は、`integer` や `real` の列なら `number`、`bigint({ mode: 'bigint' })` の列なら `bigint`、`numeric` や `decimal` の列なら `string` になります。Drizzle がこれらの列を、桁が落ちないように文字列で扱うのに合わせています。`avg()` は、`number` の列なら `number` を、それ以外の列なら小数の文字列を返します。

一致する行が無いとき、`sum()` はその型のゼロ(`0`、`0n`、`'0'`)を返し、ほかの 3 つは `null` を返します。`count()` と同じく、`limit()` と `offset()` は無視されます。

`number` の列の合計が `Number.MAX_SAFE_INTEGER` を超えた場合は、値を丸めずに例外を投げます。そうした列は `mode: 'bigint'` で宣言してください。

### Drizzle に渡す（`toDrizzle()`）

`toDrizzle()` を使うと、モデルの条件とグローバルスコープを `WHERE` 句に入れたまま、クエリを Drizzle に引き渡せます。結合や独自の select など、ビルダーでは書けないクエリに使います。

```ts
import { getDatabase } from '@/config/database'
import { posts, users } from '@/db/schema'
import { desc, eq, gt } from 'drizzle-orm'

const db = await getDatabase()
const rows = await Post.where('status', 'published')
  .toDrizzle(
    db.select({ id: posts.id, title: posts.title, author: users.name })
      .from(posts)
      .leftJoin(users, eq(posts.authorId, users.id)),
  )
  .where(gt(posts.views, 100))
  .orderBy(desc(posts.id))
```

- 引数なしの `toDrizzle()` は `select().from(table)` から始まり、トランザクションが開いていればその中で実行されます。クエリを渡した場合は、そのクエリを組み立てたハンドルで実行されます。[`Model.transaction()`](#トランザクション) の中では、`trx` から組み立ててください。
- 戻り値にさらに `.where()` を付けると、モデルの条件と AND で結合されるので、スコープが外れることはありません。すでに `where()` を呼んだクエリを渡すときは、その前に `$dynamic()` を呼んでください。
- ビルダーの `orderBy()`、`limit()`、`offset()` は引き継がれます。`select()` を引き継ぐのは引数なしの形だけで、クエリを渡した場合はそのクエリの select がそのまま使われます。
- 行は Drizzle が読んだ形のまま返り、キャスト、アクセサ、Eager Loading は適用されません。
- `toSql()` は、同じ条件を 1 つの `SQL` 断片として返します。素の Drizzle の select では 2 回目の `.where()` が 1 回目を置き換えてしまうので、自分で組み立てるクエリでは `and()` でつないでください。

```ts
const popular = await db.select().from(posts).where(and(Post.newQuery().toSql(), gt(posts.views, 100)))
```

`db` だけで書いたクエリはモデルを通らないので、スコープは 1 つも適用されません。`Model.query()` はそうしたクエリを返していたので、非推奨になりました([アップグレード](./upgrading.md)を参照)。

> [!TIP]
> Drizzle のリレーショナルクエリ（`db.query.<table>.findMany(...)`）を使いたい場合は、`drizzle-orm` の `defineRelations(schema, ...)` で作った値を `relations` オプションに渡してください (RQB v2)。Guren の `Model` API だけを使うなら、この設定は要りません。

## 作成と更新

```ts
// 作成
const post = await Post.create({
  title: 'Hello World',
  body: 'Welcome to Guren!',
})

// 更新
await Post.update({ id: post.id }, { title: 'Updated Title' })

// 削除
await Post.delete({ id: post.id })
```

一括の `update()`・`forceUpdate()`・`delete()` では、`limit()`・`offset()`・`orderBy()` を指定できません。先に対象の ID を取得してから、`whereIn()` で更新・削除してください。`SoftDeletes` を使うモデルでは、ビルダーの `delete()` も論理削除になります。物理削除には `forceDelete()` を使います。

### トランザクション

複数の書き込みを、すべて成功するかすべて失敗するかのどちらかにしたい場合は、`Model.transaction()` を使います。

```ts
await Post.transaction(async (trx) => {
  const post = await Post.create({
    title: 'Atomic write',
    body: 'Everything in one transaction',
  }, { trx })

  await Post.update({ id: post.id }, { status: 'published' }, { trx })
})
```

コールバック内で例外が投げられると、トランザクションはロールバックされます。

コールバックの第 2 引数は、トランザクションにバインドしたモデルです。これを使えば `{ trx }` を渡す手間が省けます。

```ts
await Post.transaction(async (_trx, txPost) => {
  const post = await txPost.create({
    title: 'Scoped write',
    body: '手動で { trx } を渡さない',
  })

  await txPost.update({ id: post.id }, { status: 'published' })
})
```

知っておくことは次のとおりです。

- **`{ trx }` を渡さない呼び出しもトランザクションに加わります。** コールバックの中でハンドルを渡さずにモデルを呼んでも、プールには回らず、開いているトランザクションの上で実行されます。プールに回ると、接続が 1 本だけのプールでは、その接続を使っているトランザクションを待ち続けることになります。
- **入れ子の `Model.transaction()` はセーブポイントになります。** 内側の書き込みは外側と一緒にコミットまたはロールバックされ、内側のエラーを外側のコールバックが捕まえた場合は、内側の書き込みだけが取り消されます。入れ子のトランザクションは 1 つずつ await してください。1 つの接続の上のセーブポイントは作った順に解放されるので、2 つを同時に走らせると互いのフレームを壊してしまいます。
- **SQLite ではトランザクションが 1 つずつ実行されます。** SQLite は接続を 1 つしか持たないので、同時に開始したトランザクションは順番に実行され、それぞれが個別にコミットまたはロールバックされます。トランザクションの外からのモデルの読み書きはトランザクションが終わるまで待ち、引数なしの `toDrizzle()` を await した場合も同じです。同期実行の `.all()`・`.get()`・`.run()`・`.values()` は待てないので、別のリクエストがトランザクションを開いている間に呼ぶと例外になります。`db` から自分で組み立てた Drizzle のクエリは待たずにそのトランザクションの中で実行されてしまうので、先にトランザクションの終了を待ってください。

### マスアサインメント保護

`fillable` を使うと、`create()` や `update()` で値を設定できるフィールドを限定できます。

```ts
export class Post extends defineModel(posts, {
  // これらのフィールドのみ一括代入可能。
  // テーブルのカラム名に対して型チェックされ、タイプミスはコンパイルエラーになる
  fillable: ['title', 'body', 'status'],
}) {}
```

クラス側で `static fillable = ['title', 'body', 'status']` と宣言しても、同じ許可リストになります。ただし、オプションで渡す書き方なら TypeScript がすべてのフィールド名をテーブルと照合するので、こちらをおすすめします(サブクラスで `static` を宣言すると、オプションの値は上書きされます)。

`fillable` を設定すると、許可リストに無いフィールドを `create()` や `update()` に渡したときに、`MassAssignmentException`(`@guren/core` から export されています)が投げられます。エラーメッセージには、拒否されたフィールド名が入ります。打ち間違いやインジェクションの試みが黙って捨てられ、あとで NOT NULL 違反として表に出るのではなく、呼び出したその場で気づけます。

```ts
await Post.create({ title: 'Hello', body: '...', status: 'draft', authorId: 1 })
// MassAssignmentException: Post: mass assignment blocked for field(s) "authorId"
```

#### サーバーが決めるカラム

投稿の著者、コメントが属する投稿、初期のステータスのように、行には必要でもリクエストから受け取ってはいけないカラムがあります。こうしたカラムは `fillable` に入れず、バリデート済みのデータとは別に `set` オプションで渡します。

```ts
const author = await this.auth.userOrFail<UserRecord>()
const data = await this.validateBody(PostPayloadSchema)

const post = await Post.create(data, { set: { authorId: author.id } })
await Post.update({ id: post.id }, data, { set: { status: 'draft' } })
```

クエリビルダーの一括更新も同じオプションを受け付けます: `Post.where('status', 'draft').update(data, { set: { reviewedAt: new Date() } })`。

`data` はこれまでどおり `fillable` で絞り込まれ、`set` のキーだけが許可リストを通らずに書き込まれます。`set` は 2 つを分けておくための仕組みなので、次の場合は `MassAssignmentException` になります。

- `set` のキーが `fillable` に含まれている(リクエストからすでに設定できるので、`data` に入れるべきキーです)。
- `set` で設定するキーが `data` にも入っている。
- `set` のキーが `id` か認証情報のカラムである。
- モデルが `fillable` を宣言していない。

`{ set: { ...data, authorId } }` と書くと、展開で `fillable` のキーが `set` に入るので、たいていは 1 つ目の規則で例外になります。ただし、展開したデータに `fillable` のキーが 1 つも無いと例外にならないので、これを当てにはできません。リクエストの入力は `set` に展開しないでください。`set` のリテラルの中に書いた展開は、`guren audit` が警告します(`set-spread:*`)。

#### 許可リストを通さない書き込み（`forceCreate` / `forceUpdate`）

OAuth のアカウント連携、シーダー、システムが作るレコードのように、リクエストのデータをまったく含まない書き込みには、許可リストを無視する `forceCreate()` / `forceUpdate()` を使います。

```ts
const user = await User.forceCreate({
  name: profile.name,
  email: profile.email,
  passwordHash: `oauth:${provider}:${profile.id}`,
})

await User.forceUpdate({ id: user.id }, { emailVerifiedAt: new Date() })
```

> [!WARNING]
> `forceCreate()` / `forceUpdate()` は、マスアサインメント保護をまったく通しません。リクエストの入力は、バリデート済みかどうかにかかわらず渡さないでください。リクエストのデータにサーバーが決めるカラムを足すときは `set` を使います。

`fillable` の設定に関係なく、次の2つの保護は常に働きます。

- 主キー(`id`)は、一括代入の入力から常に黙って取り除かれます。フォームが `id` を送り返してきても、書き込み先の行は変わりません。
- `AuthenticatableModel` を継承したモデルでは、認証情報のカラム(パスワードハッシュとリメンバートークン)を渡すと常に例外が投げられます。`fillable` に並べても許可されません。平文の `password` を渡してモデルにハッシュ化させるか、信頼できるサーバー側の値なら `forceCreate()` / `forceUpdate()` を使ってください。

> [!NOTE]
> `fillable` を設定していない場合は、`id` と拒否される認証情報のカラムを除いて、すべてのカラムに代入できます。ユーザーの入力を受け取るモデルには、必ず宣言してください。

## クエリスコープ

何度も使うクエリの条件は、モデルに名前付きのスコープとして定義できます。よく使うフィルタに名前が付くので、探すのも組み合わせるのも楽になります。

```ts
import { defineModel, type QueryBuilder } from '@guren/core'
import { posts } from '@/db/schema'

export type PostRecord = typeof posts.$inferSelect

export class Post extends defineModel(posts) {
  static scopes = {
    published: (q: QueryBuilder<PostRecord>) => q.where('status', 'published'),
    popular: (q: QueryBuilder<PostRecord>) => q.where('views', '>', 1000),
    recent: (q: QueryBuilder<PostRecord>) => q.orderBy('createdAt', 'desc').limit(10),
  }
}
```

スコープは `.scope()` で適用します。

```ts
// 単一のスコープ
const published = await Post.scope('published').get()

// 複数のスコープをチェーン
const trending = await Post.scope('published').scope('popular').get()

// スコープと追加のクエリ条件を組み合わせる
const myPopularPosts = await Post.scope('published')
  .scope('popular')
  .where('authorId', currentUser.id)
  .get()
```

## グローバルスコープ

グローバルスコープは、モデルのすべてのクエリに自動で適用されるフィルタです。マルチテナンシーやソフトデリートのように、常にかけておきたい条件に使います。

```ts
// 現在のテナントで常にフィルタ
User.addGlobalScope('tenant', (q) => q.where('tenantId', currentTenantId()))

// 非アクティブユーザーを常に除外
User.addGlobalScope('active', (q) => q.where('active', true))
```

グローバルスコープは、クエリを始めるどのメソッドにも自動で適用されます。対象は `all()`、`find()`、`first()`、`where()` とその `whereIn` / `whereNull` / `select` 系、`scope()`、`orderBy()`、`paginate()`(行だけでなく件数にも)、`newQuery()`、そしてリレーションを eager load するクエリ(この場合は*関連先*のモデルのスコープが適用されます)です。

書き込みにも適用されます。`update()`・`forceUpdate()`・`delete()` は `where` に同じスコープを加えるので、`tenant` スコープがあれば、別のテナントの行を読むことだけでなく、更新や削除も防げます。

スコープを外すには、次に説明する方法で明示的に指定します。

### グローバルスコープの一時除外

特定のスコープを、1 回のクエリでだけ外せます。

```ts
const allUsers = await User.withoutGlobalScope('active').get()
```

すべてのグローバルスコープを外すには、次のようにします。

```ts
const everyone = await User.withoutGlobalScopes().get()
```

スコープそのものを削除することもできます。

```ts
User.removeGlobalScope('active')
```

> [!TIP]
> `SoftDeletes` ミックスインは、`'softDelete'` という名前のグローバルスコープを登録します。`withTrashed()` は `withoutGlobalScope('softDelete')` と同じ処理なので、どちらで書いても削除済みのレコードまで取得でき、ほかのグローバルスコープはそのまま適用されます。`tenant` スコープによるテナントの分離も保たれます。それも含めてすべてのスコープを外すには、`withoutGlobalScopes()` を使います。

## モデルフック

フックを使うと、モデルのライフサイクルの決まったタイミングで処理を実行できます。フックは静的な `hooks` オブジェクトに定義します。

```ts
import { defineModel } from '@guren/core'
import { posts } from '@/db/schema'
import { slugify } from '@/app/utils/string'

export class Post extends defineModel(posts) {
  static hooks = {
    creating: async (data) => {
      // 新しいレコードが挿入される前に実行
      data.slug = slugify(data.title)
      data.createdAt = new Date()
    },
    created: async (data) => {
      // 新しいレコードが挿入された後に実行
      console.log('新しい投稿が作成されました:', data.id)
    },
    updating: async (data) => {
      // レコードが更新される前に実行
      data.updatedAt = new Date()
    },
    updated: async (data) => {
      // レコードが更新された後に実行
    },
    deleting: async (data) => {
      // レコードが削除される前に実行
    },
    deleted: async (data) => {
      // レコードが削除された後に実行
    },
  }
}
```

### 利用可能なフック

| フック | タイミング |
|------|--------|
| `creating` | 挿入前 |
| `created` | 挿入後 |
| `updating` | 更新前 |
| `updated` | 更新後 |
| `deleting` | 削除前 |
| `deleted` | 削除後 |
| `saving` / `saved` | 挿入と更新の前／後（どちらでも呼ばれる） |

## モデルオブザーバー

フックの処理が複雑になってきたら、専用のオブザーバークラスに切り出せます。オブザーバーはフックと同じライフサイクルイベントを受け取りますが、別のファイルに分けて置けます。

```ts
// app/Observers/PostObserver.ts
import type { ModelObserver, PlainObject } from '@guren/core'

export class PostObserver implements ModelObserver {
  creating(data: PlainObject) {
    data.slug = slugify(data.title as string)
  }

  async created(data: PlainObject) {
    await notifySubscribers(data)
  }

  async deleting(data: PlainObject) {
    await clearPostCache(data.id)
  }
}
```

オブザーバーはモデルに登録して使います。

```ts
import { PostObserver } from '@/app/Observers/PostObserver'

Post.observe(PostObserver)
```

操作の前に呼ばれるイベント(`creating`、`updating`、`deleting`、`saving`)で `false` を返すと、その操作は中止されます。インラインのフックと同じ動きです。

フックとオブザーバーは同時に使えます。先にフックが実行され、そのあとでオブザーバーが実行されます。

## ソフトデリート

ソフトデリートでは、レコードを実際には削除せず、`deletedAt` にタイムスタンプを入れて削除済みの印を付けます。`SoftDeletes` をミックスインすると有効になります。

```ts
import { SoftDeletes, defineModel } from '@guren/core'
import { posts } from '@/db/schema'

export class Post extends SoftDeletes(defineModel(posts)) {}
```

スキーマには `deletedAt` のタイムスタンプカラムが必要です。

### ソフトデリートの操作

```ts
// ソフトデリート - 未削除の行に deletedAt を設定する（行自体は削除しない）
await Post.delete({ id: 1 })

// 削除されていないレコードのみ取得（デフォルトの動作）
const activePosts = await Post.all()

// ソフトデリート済みレコードも含めて取得
const allPosts = await Post.withTrashed().get()

// ソフトデリート済みレコードのみ取得
const trashedPosts = await Post.onlyTrashed().get()

// ソフトデリートを復元（deletedAt をクリア）
await Post.restore({ id: 1 })

// 完全に削除（ソフトデリートをバイパス）
await Post.forceDelete({ id: 1 })
```

これらのメソッドには、どれもモデルの*ほかの*グローバルスコープが適用されます。`delete()` が`deletedAt` を設定するのは、現在のスコープから見える未削除の行だけです。すでに削除済みの行には一致しないので、元の `deletedAt` はそのまま残ります。

`restore()` と`forceDelete()` は、削除済みのレコードを対象にするために `softDelete` フィルタだけを外し、ほかのスコープは残します。そのため `tenant` スコープがあれば、取り消しのきかない`forceDelete()` が別のテナントの行を消すことはありません。

トランザクションの中では、どのメソッドにもトランザクションのハンドルを渡せます。`delete()` はトランザクションスコープから呼び、それ以外はほかの書き込みと同じく最後の引数で渡します。

```ts
await Post.transaction(async (trx, txPost) => {
  await txPost.delete({ id: 1 })
  await Post.restore({ id: 2 }, { trx })
  await Post.forceDelete({ id: 3 }, { trx })
  const trashed = await Post.onlyTrashed({ trx }).get()
})
```

## 属性キャスト

`static casts` を定義すると、データベースから読み取ったカラムの値が自動で変換されます。

```ts
export class Post extends defineModel(posts) {
  static casts = {
    metadata: 'json',       // JSON 文字列をオブジェクトにパース
    publishedAt: 'date',    // Date インスタンスに変換
    isActive: 'boolean',    // boolean に変換
    viewCount: 'number',    // number に変換
  }
}
```

### 利用可能なキャストタイプ

| キャスト | 説明 |
|------|-------------|
| `'json'` | JSON 文字列をオブジェクト/配列にパース |
| `'date'` | `Date` インスタンスに変換 |
| `'boolean'` | boolean に変換 |
| `'number'` | number に変換 |
| `'string'` | string に変換 |

## アクセサとミューテータ

アクセサは、レコードを読み取るときに仮想的な属性を計算します。ミューテータは、データベースに書き込む前に値を変換します。

### アクセサ

レコードを取得したときに自動で計算されるプロパティを定義します。

```ts
export class User extends defineModel(users, {
  accessors: {
    // `record` はテーブルのレコード型 — フィールド名のタイプミスはコンパイルエラー
    fullName: (record) => `${record.firstName} ${record.lastName}`,
    isAdmin: (record) => record.role === 'admin',
  },
}) {}
```

(クラス側の `static accessors = { ... }` も使えますが、`record` 引数には型が付きません。)

```ts
const user = await User.find(1)
console.log(user.fullName)  // "John Doe"
```

アクセサは、`all()`、`find()`、`where()`、`first()`、`paginate()` のどれで読み取っても実行されます。

### ミューテータ

入力データを、データベースに保存する前に変換します。

```ts
export class User extends defineModel(users) {
  static mutators = {
    email: (value) => String(value).toLowerCase().trim(),
    name: (value) => String(value).trim(),
  }
}
```

```ts
await User.create({ email: '  JOHN@EXAMPLE.COM  ', name: '  John  ' })
// 保存される値: email = "john@example.com", name = "John"
```

ミューテータは `create()` と `update()` のどちらでも、フックやキャストのシリアライズより先に実行されます。

## シリアライゼーション

API レスポンスや Inertia の props に、モデルのレコードをどう出すかを制御できます。

### フィールドの非表示

機密情報のフィールドを、シリアライズした出力から外します。

```ts
export class User extends defineModel(users, {
  hidden: ['passwordHash', 'rememberToken'],
}) {}
```

`fillable` と同じく、このオプションの値はテーブルのカラム名と照らして型チェックされます。`static hidden = [...]` の書き方も引き続き使えます。

```ts
const user = await User.find(1)
const json = User.serialize(user)
// { id: 1, name: "John", email: "john@example.com" }
// passwordHash と rememberToken は除外される
```

`hidden` に並べたフィールドは `auth.user()` が返すレコードからも取り除かれるので、ログイン中のユーザーを渡す Inertia の共有 props や API レスポンスに漏れることはありません。詳細は[認証ガイド](./authentication.md)を参照してください。

### 表示フィールドのホワイトリスト

隠すフィールドを並べる代わりに、表示するフィールドを並べることもできます。

```ts
export class User extends defineModel(users, {
  visible: ['id', 'name', 'email'],
}) {}
```

`visible` を設定すると、そこに並べたフィールドだけが出力されます。`visible` は `hidden` より優先されます。

### 仮想属性の追加

アクセサで計算した値を、シリアライズした出力に含めます。

```ts
export class User extends defineModel(users, {
  accessors: {
    fullName: (record) => `${record.firstName} ${record.lastName}`,
  },
  appends: ['fullName'],
  hidden: ['firstName', 'lastName'],
}) {}
```

`appends` に書けるのは、同じオプションの `accessors` で宣言した名前だけです。宣言していない名前を書くとコンパイルエラーになります。

```ts
const json = User.serialize(user)
// { id: 1, fullName: "John Doe", email: "john@example.com" }
```

### コレクションのシリアライズ

```ts
const users = await User.all()
const json = User.serializeMany(users)
```

> [!TIP]
> `serialize()` と `serializeMany()` は、Inertia ページの props や API レスポンスを組み立てるのに向いています。もっと複雑な変換が必要なら、`JsonResource` と組み合わせてください。

## ページネーション

クエリの結果をページに分け、ページ送りを作るためのメタデータを受け取ります。

```ts
const result = await Post.paginate({ page: 1, perPage: 10 })
// result.data  — 現在のページの PostRecord[]
// result.meta  — { total, perPage, currentPage, totalPages, hasMore, from, to }
```

ページネーションのデータは、そのまま Inertia のページに渡せます。

```ts
import { Controller, paginate, type PaginatedPageProps } from '@guren/core'
import { PostResource, type PostResourceData } from '@/app/Http/Resources/PostResource'
import { pages } from '@/.guren/pages.gen'

type PostsIndexProps = PaginatedPageProps<PostResourceData>

async index() {
  const page = Number(this.query('page', '1'))
  const result = await Post.scope('published').paginate({ page, perPage: 15 })
  const paginator = paginate(result, { path: this.request.path ?? '/posts' })

  return this.inertia(pages.posts.Index, {
    data: result.data.map((post) => new PostResource(post).toJSON()),
    pagination: {
      meta: paginator.meta(),
      links: paginator.links(),
    },
  } satisfies PostsIndexProps)
}
```
