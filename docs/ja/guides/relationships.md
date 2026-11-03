# リレーション

リレーションは、それを持つモデルの隣に宣言し、あとはどこからでも eager load します。リレーションは、`hasMany()` や `belongsTo()` など、以下で紹介するメソッドでモデルのクラスに登録します。モデルそのものについては[モデル](./models.md)を参照してください。

## hasMany / belongsTo

```ts
// app/Models/User.ts
import { defineModel, type HasManyRecord } from '@guren/core'
import { users } from '@/db/schema'
import type { PostRecord } from '@/app/Models/Post'

export type UserRecord = typeof users.$inferSelect

export class User extends defineModel(users) {
  static override relationTypes: { posts: HasManyRecord<PostRecord> } = {
    posts: [],
  }
}

User.hasMany('posts', () => import('./Post.js').then((m) => m.Post), 'authorId', 'id')

// app/Models/Post.ts
import { defineModel, type BelongsToRecord } from '@guren/core'
import { posts } from '@/db/schema'
import type { UserRecord } from '@/app/Models/User'

export type PostRecord = typeof posts.$inferSelect

export class Post extends defineModel(posts) {
  static override relationTypes: { author: BelongsToRecord<UserRecord> } = {
    author: null,
  }
}

Post.belongsTo('author', () => import('./User.js').then((m) => m.User), 'authorId', 'id')
```

`relationTypes` は、各リレーションを読み込んだときの型を TypeScript に伝えます。値（`[]` や `null`）は実行時のプレースホルダーです。値の要らない `declare` の書き方は[読み込んだリレーションの型](#読み込んだリレーションの型)で紹介します。関連モデルは、それを import する関数として渡すので、2 つのモデルが互いを参照しても循環 import になりません。

## その他のリレーション

```ts
import { userRoles } from '@/db/schema'

User.hasOne('profile', Profile, 'userId', 'id')
User.belongsToMany('roles', Role, userRoles, 'userId', 'roleId')
Country.hasManyThrough('posts', Post, User, 'countryId', 'authorId')
```

| メソッド | 引数 |
|----------|------|
| `hasMany(name, Related, foreignKey, localKey)` | 関連テーブル側の外部キーと、それが指すこのモデルのキー（通常は `id`）。配列を読み込み、一致しなければ `[]` |
| `belongsTo(name, Related, foreignKey, ownerKey)` | このモデルの外部キーと、関連モデルのキー。1 件のレコードか `null` を読み込む |
| `hasOne(name, Related, foreignKey, localKey)` | `hasMany` と同じだが、1 件のレコードか `null` を読み込む |
| `belongsToMany(name, Related, pivotTable, foreignPivotKey, relatedPivotKey, parentKey?, relatedKey?)` | ピボットテーブルを介した多対多 |
| `hasManyThrough(name, Related, Through, firstKey, secondKey)` | 中間のモデルを経由してたどるレコード |
| `morphMany(name, Related, morphName, localKey)` / `morphTo(name, morphName)` | ポリモーフィックリレーション（次の節） |

`belongsToMany` の `pivotTable` には、テーブル名の文字列ではなく、`@/db/schema` から export した Drizzle のテーブルオブジェクトを渡します。`foreignPivotKey` と `relatedPivotKey` はどちらも*ピボット側*の列で、それぞれこのモデルと関連モデルを参照します。`parentKey` と `relatedKey` はその参照先のローカルキーで、既定値はどちらも `'id'` です。

## ポリモーフィックリレーション

ポリモーフィックリレーションを使うと、1 つのリレーションで複数の種類の親モデルに属せます。たとえば、投稿にも動画にもコメントを付けられます。

関連テーブルには、type と id のカラムを定義します。

```ts
// db/schema.ts
export const comments = pgTable('comments', {
  id: serial('id').primaryKey(),
  body: text('body').notNull(),
  commentableType: text('commentable_type').notNull(),
  commentableId: integer('commentable_id').notNull(),
})
```

次に、リレーションを登録します。

```ts
// 親モデル
Post.morphMany('comments', Comment, 'commentable', 'id')
Video.morphMany('comments', Comment, 'commentable', 'id')

// 子モデル（逆向き）
Comment.morphTo('commentable', 'commentable')

// type の文字列とモデルクラスの対応
Model.morphMap = {
  'Post': Post,
  'Video': Video,
}
```

あとは通常のリレーションと同じように取得できます。

```ts
const postWithComments = await Post.with('comments')
const comment = await Comment.findWith(1, 'commentable')
console.log(comment.commentable) // Post か Video のレコード
```

## Eager Loading

`Model.with()` を使うと、1 つ以上のリレーションを eager load できます。戻り値は各レコードの浅いコピーで、リレーションに付けた名前のプロパティに関連データが入ります。

```ts
// ユーザーと投稿を一緒に読み込む
const users = await User.with('posts')

// eager loading とフィルタを組み合わせる
const posts = await Post.with('author', { authorId: [1, 2] })

// posts[0].author は関連する UserRecord か null（belongsTo の場合）
```

eager loading は QueryBuilder でも使えるので、フィルタや並べ替えと組み合わせられます。レコードを返す `get()`、`first()`、`firstOrFail()`、`paginate()` のどれを使っても、リレーションが付いてきます。

```ts
const activeUsers = await User.where('active', true)
  .with('posts')
  .orderBy('name')
  .get()

const user = await User.newQuery().with('posts').first()

// ページの各行にも author が付きます
const page = await Post.newQuery().with('author').orderBy('id', 'desc').paginate({ page: 1, perPage: 10 })
```

### ネストしたリレーション

ネストしたリレーションは、ドットでつないで指定します。

```ts
const users = await User.with('posts.comments')
```

同じリレーションから複数のパスに枝分かれさせることもできます。共通する先頭のリレーションは一度だけ読み込まれるので、どの枝の結果も同じレコードに付きます。

```ts
const users = await User.newQuery().with('posts.comments', 'posts.tags').get()

users[0].posts[0].comments // 読み込まれます
users[0].posts[0].tags     // こちらも読み込まれます
```

### 読み込む関連レコードを絞り込む

QueryBuilder では、`with()` にオブジェクトを渡してリレーションごとにコールバックを指定し、読み込むクエリに条件を加えられます。コールバックが受け取るクエリビルダーには外部キーでの絞り込みがすでにかかっているので、`where()` を呼ぶと、読み込む関連レコードがさらに絞り込まれます。

```ts
const users = await User.newQuery()
  .with({ posts: (q) => q.where('published', true) })
  .get()

users[0].posts // published な投稿だけが入る
```

それぞれのキーは、そのキーが指す階層にだけ効き、キーを書く順番は結果に影響しません。ドットを含むキーは最後の階層にだけ効くので、先頭のリレーションは絞り込まれません。両方の階層を絞り込みたい場合は、両方のキーを指定してください。

```ts
// `posts` は絞り込まれず、`comments` だけが絞り込まれる
await User.newQuery()
  .with({ 'posts.comments': (q) => q.where('approved', true) })
  .get()

// 両方の階層を絞り込む
await User.newQuery()
  .with({
    posts: (q) => q.where('published', true),
    'posts.comments': (q) => q.where('approved', true),
  })
  .get()
```

> [!WARNING]
> コールバックの一番外側で `orWhere()` を呼ぶと、ローダーが加えた外部キーの条件と
> OR でつながるので、絞り込むどころか**条件が広がってしまいます**。次のように
> グループにまとめてください: `q.where((g) => g.where('a', 1).orWhere('b', 2))`
>
> `select()` を使う場合は、リレーションのキーになる列(`hasMany` や `hasOne` なら
> 外部キー、`belongsTo` ならオーナーキー)を必ず含めてください。含めないと、ローダー
> が親レコードと突き合わせられず、リレーションが空になります。

> [!NOTE]
> リレーションは親レコードごとに読み込むのではなく、まとめて読み込みます。その
> ため、コールバックの中の `limit()` は、親ごとではなく結果全体に効きます。
> `limit()`・`offset()`・`orderBy()` を含むコールバックでは、キーを分けずに 1 本の
> クエリで読み込みます。含まない場合は、ドライバーのパラメータ数の上限に収まるよう
> にキーを分けて読み込みます。`belongsToMany` と `hasManyThrough` で分けられるのは、
> 親のキーではなく関連先のキーです。`morphTo` ではコールバックが対象の型ごとに
> 実行されるので、参照できるのはすべての対象に共通する列だけです。

`belongsToMany` と `hasManyThrough` では、コールバックは**関連先モデル**のクエリに条件を加えます。取得する行を決めるピボットテーブルや中間テーブルの検索には効かないので、関連先モデル自身の列で絞り込んでください。

```ts
// 各投稿の `news` タグだけを残す。ピボットの検索はそのまま
await Post.newQuery()
  .with({ tags: (q) => q.where('label', 'news') })
  .get()
```

静的メソッドの `Model.with()` はシグネチャが違い、第 2 引数は**親**レコードを絞り込む条件です。コールバックで条件を加えたい場合は、`Model.newQuery().with({ ... })` を使ってください。

### 読み込んだリレーションの型

`relationTypes` から型が付くのは、ネストしたパスの先頭のセグメントに限られます。ネストの先まで型を付けたい場合は、先頭のリレーションのレコード型の中に、ネストした形を宣言してください。

```ts
export class User extends defineModel(users) {
  declare static relationTypes: {
    posts: HasManyRecord<PostRecord & { comments: CommentRecord[] }>
  }
}

const loaded = await User.with('posts.comments')
loaded[0].posts[0].comments // CommentRecord[] — 末端まで型付き
```

> [!NOTE]
> `relationTypes` と照合するのは、先頭のセグメント（上の例では `posts`）に限られます。最初のドットより後ろは検証されない文字列なので、打ち間違いや不正な末尾(`'posts.'`・`'posts..comments'`・`'posts.typo'`)があってもコンパイルは通ります。実行時には、末尾が知らないリレーション名ならエラーになります。ただしそれは、ローダーが読み込んだ子レコードの中まで実際にたどった場合に限られます。先頭のリレーションがどのレコードでも 0 件だった場合は、末尾は一切検査されず、何も起きずに終わります。`morphTo` のリレーションを経由したネストは実行時に必ずエラーになりますが、この制約も型では表現されていません。

`BelongsToRecord<T>` は常に `T | null` です。外部キーが `NOT NULL` で、親レコードが必ず存在する場合は、代わりに `BelongsToRequiredRecord<T>` で宣言できます。`declare` 修飾子を使えば、実行時用のプレースホルダーの値も要りません。

```ts
export class Comment extends defineModel(comments) {
  declare static relationTypes: {
    author: BelongsToRequiredRecord<UserRecord>
  }
}

const comments = await Comment.with('author')
comments[0].author.name // null チェック不要
```

## リレーション件数の取得

`withCount()` は、関連レコードそのものは読み込まずに、`${name}Count` フィールドだけを付けます。件数だけを表示する一覧ページに向いています。

```ts
const users = await User.withCount('posts')        // users[0].postsCount は number
const posts = await Post.withCount(['comments', 'author'], { published: true })
```

対応しているのは、`hasMany` / `hasOne` / `morphMany`(レコードごとの子の件数)と、`belongsTo`(0 か 1)です。

