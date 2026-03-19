# データベースガイド

Guren は Drizzle ORM と PostgreSQL を組み合わせて使います。このガイドでは、スキーマ定義、マイグレーション、シーダー、アプリケーションコードからの日常的な利用方法を説明します。

## 設定の概要
- `config/database.ts`: データベース接続を生成し、フレームワークに公開します。
- `drizzle.config.ts`: drizzle-kit の共通設定（スキーマパス、マイグレーション出力先、DB 方言など）。
- `db/schema.ts`: モデルとマイグレーションで使用する Drizzle のスキーマ定義。
- `db/migrations/`: 生成または手書きの SQL マイグレーション。
- `db/seeders/`: サンプルデータを投入するシードスクリプト。

`.env` ファイルで `DATABASE_URL` を設定してください（デフォルト値: `postgres://guren:guren@localhost:54322/guren`）。

## スキーマ定義
`db/schema.ts` で Drizzle のスキーマビルダーを使います。

```ts
import { pgTable, serial, text, boolean, timestamp, jsonb } from 'drizzle-orm/pg-core'

export const posts = pgTable('posts', {
  id: serial('id').primaryKey(),
  title: text('title').notNull(),
  body: text('body').notNull(),
  status: text('status').notNull().default('draft'),
  metadata: jsonb('metadata'),
  publishedAt: timestamp('published_at'),
  deletedAt: timestamp('deleted_at'),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
})
```

テーブルは `static table` に割り当ててモデルに公開します。

```ts
// app/Models/Post.ts
import { Model } from '@guren/orm'
import { posts } from '@/db/schema'

export type PostRecord = typeof posts.$inferSelect

export class Post extends Model<PostRecord> {
  static override table = posts
  static override readonly recordType = {} as PostRecord
}

// `recordType` により Post.find() などの静的ヘルパーが Drizzle から推論された正確な型を返します。
```

## マイグレーションの生成
Guren CLI は drizzle-kit をラップしており、Drizzle スキーマから SQL ファイルを直接生成できます。

```bash
bunx guren make:migration --name add_posts_table
```

コマンドはプロジェクトルートの `drizzle.config.ts`（`.mts/.js/.mjs` も可）を参照し、スキーマパス・出力ディレクトリ・DB 方言のデフォルト値を取得します。必要に応じてスキーマや出力先を上書きできます。

```bash
bunx guren make:migration --schema ./custom/schema.ts --out ./custom/migrations
```

空のファイルが欲しい場合は手動で作成しても構いません。マイグレーションは単なる SQL です。

## マイグレーションの実行
`db/migrations/` に SQL マイグレーションファイルを追加します（例: `0001_add_posts.sql`）。標準的な PostgreSQL 文を記述します。

```sql
CREATE TABLE posts (
  id serial PRIMARY KEY,
  title text NOT NULL,
  body text NOT NULL
);
```

マイグレーションの適用は以下のコマンドで行います。

```bash
bun run db:migrate
```

スキャフォールドに含まれるスクリプトが未適用のマイグレーションを順番に実行します。完了したマイグレーションは追跡されるため、再実行しても安全です。

> [!NOTE]
> いったんどこかの環境に適用したマイグレーションは、不変として扱ってください。修正が必要な場合は、既存の SQL ファイルを編集するのではなく、新しいマイグレーションを追加します。これにより、すべてのデプロイ環境で履歴の一貫性が保たれます。

## データ投入（シード）
シードスクリプトを `db/seeders/` に配置します。典型的なシーダーは、async の `run()` 関数をエクスポートします。

```ts
// db/seeders/PostsSeeder.ts
import { Post } from '@/app/Models/Post'

export async function run() {
  await Post.create({ title: 'Hello', body: 'Welcome to Guren!' })
}
```

すべてのシーダーを実行するには以下のコマンドを使います。

```bash
bun run db:seed
```

開発・テスト・デモ環境のフィクスチャ投入にシーダーを活用してください。

> [!CAUTION]
> シードスクリプトはデータを変更・削除する可能性があります。シーダーがその環境向けに明示的に設計されていない限り、本番データベースに対して実行しないでください。

## ORM の使い方
`DatabaseProvider`（または `bootModels()` を呼ぶ独自プロバイダー）がアプリケーション起動時に実行されると、すべてのモデルが設定済みのデータベースアダプターにアクセスできるようになります。よく使うヘルパーは以下の通りです。

```ts
await Post.all()            // 全件取得
await Post.find(id)         // プライマリキーで検索（見つからなければ null）
await Post.findOrFail(id)   // 検索、見つからなければ ModelNotFoundException（404）をスロー
await Post.create(payload)  // 新しいレコードを挿入
await Post.first()          // 最初のマッチするレコードを返す
```

## 流暢なクエリビルダー

モデルは流暢な `QueryBuilder` を公開しており、条件・ソート・制限をチェーンしてから実行できます。

```ts
// シンプルな where 句
const posts = await Post.where('status', 'published').get()

// 演算子付きの複数条件
const popular = await Post.where('status', 'published')
  .where('views', '>', 100)
  .orWhere('featured', true)
  .orderBy('createdAt', 'desc')
  .limit(10)
  .get()

// オブジェクト構文によるシンプルな等値比較
const admins = await User.where({ role: 'admin' })

// thenable - .get() なしで直接 await 可能
const users = await User.where({ role: 'admin' })
```

`QueryBuilder` は thenable なので、直接 `await` することも `.get()` を明示的に呼ぶこともできます。どちらも同じ結果になります。

### 利用可能な QueryBuilder メソッド

| メソッド | 説明 |
|--------|-------------|
| `.where(column, value)` | 等値でフィルタ |
| `.where(column, operator, value)` | 演算子でフィルタ（`>`、`<`、`>=`、`<=`、`!=`、`LIKE`） |
| `.where(object)` | 複数の等値条件でフィルタ |
| `.orWhere(column, value)` | OR 条件 |
| `.orWhere(column, operator, value)` | 演算子付き OR 条件 |
| `.orderBy(column, direction?)` | 結果をソート（`'asc'` または `'desc'`） |
| `.limit(n)` | 結果件数を制限 |
| `.offset(n)` | 最初の n 件をスキップ |
| `.get()` | クエリを実行して結果の配列を返す |
| `.first()` | クエリを実行して最初の結果または null を返す |
| `.count()` | マッチするレコードの件数を返す |

### クイックテンプレート: モデルファースト vs RQB

用途に合った方を選んでください。どちらも型安全です。

```ts
// モデルファースト（簡潔な CRUD、流暢なビルダー）
import { Post } from '@/app/Models/Post'

const posts = await Post.where('status', 'published')
  .orderBy('publishedAt', 'desc')
  .limit(10)
  .get()
```

```ts
// Drizzle RQB（結合・集約向き）
import { getDatabase } from '@/config/database'
import { posts, users } from '@/db/schema'
import { eq, desc } from 'drizzle-orm'

const db = await getDatabase()
const rows = await db
  .select({
    id: posts.id,
    title: posts.title,
    author: users.name,
  })
  .from(posts)
  .leftJoin(users, eq(posts.authorId, users.id))
  .orderBy(desc(posts.id))
```

### Drizzle 直接利用（RQB）と `Model.query()`

Guren は Drizzle ファーストの設計です。リレーショナルクエリビルダーに直接アクセスしても、モデルを便利なエントリーポイントとして使っても構いません。

```ts
// Drizzle を直接利用（型安全）
import { getDatabase } from '@/config/database'
import { schema } from '@/db/schema'
import { desc } from 'drizzle-orm'
import { Post } from '@/app/Models/Post'

const db = await getDatabase()
const recent = await db
  .select()
  .from(schema.posts)
  .orderBy(desc(schema.posts.createdAt))
  .limit(5)

// モデルを起点にしつつ RQB のコントロールを維持
const recentViaModel = await Post.query(db)
  .orderBy(desc(schema.posts.createdAt))
  .limit(5)
```

素早い CRUD にはモデルヘルパーを使い、複雑な述語・結合・ドライバー固有の API が必要な場合は RQB（`db.select().from(...)` や `Model.query(db)`）に切り替えてください。

## クエリスコープ

再利用可能なクエリ制約を、モデル上の名前付きスコープとして定義できます。スコープを使えば、よく使うフィルタを見つけやすく、組み合わせやすくなります。

```ts
import { Model, type QueryBuilder } from '@guren/orm'
import { posts } from '@/db/schema'

export type PostRecord = typeof posts.$inferSelect

export class Post extends Model<PostRecord> {
  static override table = posts
  static override readonly recordType = {} as PostRecord

  static scopes = {
    published: (q: QueryBuilder<PostRecord>) => q.where('status', 'published'),
    popular: (q: QueryBuilder<PostRecord>) => q.where('views', '>', 1000),
    recent: (q: QueryBuilder<PostRecord>) => q.orderBy('createdAt', 'desc').limit(10),
  }
}
```

`.scope()` でスコープを適用します。

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

## モデルフック

フックを使うと、モデルのライフサイクルの特定のポイントでロジックを実行できます。静的な `hooks` オブジェクトとして定義します。

```ts
import { Model } from '@guren/orm'
import { posts } from '@/db/schema'
import { slugify } from '@/utils/string'

export class Post extends Model<typeof posts.$inferSelect> {
  static override table = posts

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

## ソフトデリート

ソフトデリートは、レコードを実際に削除する代わりに `deletedAt` タイムスタンプを設定して削除済みとしてマークします。`SoftDeletes` をミックスインして有効にします。

```ts
import { Model, SoftDeletes } from '@guren/orm'
import { posts } from '@/db/schema'

export type PostRecord = typeof posts.$inferSelect

export class Post extends SoftDeletes(Model)<PostRecord> {
  static override table = posts
  static override readonly recordType = {} as PostRecord
}
```

スキーマに `deletedAt`（または同等の）タイムスタンプカラムが必要です。

### ソフトデリートの操作

```ts
// ソフトデリート - deletedAt を設定し、行は削除しない
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

## 属性キャスト

`static casts` を定義すると、データベースから読み取ったカラムの値を自動的に変換できます。

```ts
export class Post extends Model<PostRecord> {
  static override table = posts
  static override readonly recordType = {} as PostRecord

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

## マスアサインメント保護

`fillable` または `guarded` で、`create()` や `update()` で設定可能なフィールドを制御できます。

```ts
export class Post extends Model<PostRecord> {
  static override table = posts
  static override readonly recordType = {} as PostRecord

  // これらのフィールドのみ一括代入可能
  static fillable = ['title', 'content', 'status', 'authorId']
}
```

あるいは、`guarded` で特定のフィールドをブロックし、それ以外をすべて許可することもできます。

```ts
export class Post extends Model<PostRecord> {
  static override table = posts
  static override readonly recordType = {} as PostRecord

  // これらのフィールドは一括代入から保護される
  static guarded = ['id', 'createdAt', 'updatedAt']
}
```

`fillable` と `guarded` はどちらか一方を使ってください。`fillable` は許可リスト、`guarded` は拒否リストです。どちらも設定されていない場合は、すべてのフィールドが代入可能になります。

## リレーションの定義

ORM には、一般的な Eloquent スタイルのリレーション層が組み込まれています。モデルクラスにリレーションを一度だけ宣言します。`static table` の近くに置くと見通しがよくなります。

### hasMany / belongsTo

```ts
// app/Models/User.ts
import { Model, type HasManyRecord } from '@guren/orm'
import { users } from '@/db/schema'
import type { PostRecord } from '@/app/Models/Post'

export type UserRecord = typeof users.$inferSelect

export class User extends Model<UserRecord> {
  static override table = users
  static override readonly recordType = {} as UserRecord
  static override relationTypes: { posts: HasManyRecord<PostRecord> } = {
    posts: [],
  }
}

// app/Models/Post.ts
import { Model, type BelongsToRecord } from '@guren/orm'
import { posts } from '@/db/schema'
import type { UserRecord } from '@/app/Models/User'

export type PostRecord = typeof posts.$inferSelect

export class Post extends Model<PostRecord> {
  static override table = posts
  static override readonly recordType = {} as PostRecord
  static override relationTypes: { author: BelongsToRecord<UserRecord> } = {
    author: null,
  }
}

// app/Models/relations.ts
import { Post } from './Post'
import { User } from './User'

// モジュールの循環を避けるため、両方のモデルを定義した後にリレーションを記述します。
User.hasMany('posts', Post, 'authorId', 'id')
Post.belongsTo('author', User, 'authorId', 'id')
```

### hasOne

```ts
// ユーザーは一つのプロフィールを持つ
User.hasOne('profile', Profile, 'userId', 'id')
```

### belongsToMany

```ts
// ピボットテーブルを介した多対多
User.belongsToMany('roles', Role, 'user_roles', 'userId', 'roleId')
Post.belongsToMany('tags', Tag, 'post_tags', 'postId', 'tagId')
```

### hasManyThrough

```ts
// 中間モデルを経由してリモートリレーションにアクセス
Country.hasManyThrough('posts', Post, User, 'countryId', 'authorId')
```

副作用を確実に実行するため、アプリケーション起動時（例: `src/main.ts`）に `relations.ts` モジュールを一度インポートしてください。

```ts
// src/main.ts
import './app/Models/relations'
```

- `hasMany(name, RelatedModel, foreignKey, localKey)`: 関連モデルの外部キーと親側のローカルキー（通常 `id`）を指定します。
- `belongsTo(name, RelatedModel, foreignKey, ownerKey)`: 現在のモデルの外部キーと関連モデルの所有キーを結びつけます。
- `hasOne(name, RelatedModel, foreignKey, localKey)`: `hasMany` と同じように動作しますが、単一のレコードまたは `null` を返します。
- `belongsToMany(name, RelatedModel, pivotTable, foreignPivotKey, relatedPivotKey)`: ピボットテーブルを通じた多対多を処理します。
- `hasManyThrough(name, RelatedModel, ThroughModel, firstKey, secondKey)`: 中間モデルを経由してリモートリレーションにアクセスします。
- `static relationTypes` で eager load されるリレーションの型を記述します。`Model.with('author')` などのヘルパーがこれらの型をマージし、コントローラーやビューで完全に型付けされたリレーションデータを受け取れます。

### `with` による eager loading

`Model.with()` を使って、一つ以上のリレーションを eager load できます。各レコードの浅いコピーを返し、設定された名前のプロパティにリレーションデータが挿入されます。

```ts
// ユーザーと投稿を一緒に読み込む
const users = await User.with('posts')

// eager loading とフィルタを組み合わせる
const posts = await Post.with('author', { authorId: [1, 2] })

// posts[0].author は関連する UserRecord か null（belongsTo の場合）
```

`hasMany` リレーションは配列として展開されます（マッチするものがない場合は `[]`）。`belongsTo` は単一の関連レコードまたは外部キーが存在しない場合は `null` を返します。複数のリレーションを配列で渡すこともできます: `await User.with(['posts'])`。既存の `where`/`orderBy` ヘルパーと組み合わせて追加のフィルタリングも可能です。

## トランザクション
`config/database.ts` のデータベースインスタンスを使ってトランザクションを実行します。

```ts
import { db } from '@/config/database'

await db.transaction(async (tx) => {
  await tx.insert(posts).values({ title, body })
})
```

操作をアトミックに保つため、必要に応じてモデルや Drizzle クエリに `tx` を渡してください。

## Tips
- マイグレーションは冪等に保ち、2 回実行すると失敗するような破壊的な文は避けましょう。
- 可変データにはシーダーを使い、マイグレーションは追記専用として扱いましょう。
- カラムやテーブルをリネームする場合は、データ移行用のマイグレーションを明示的に用意し、情報の損失を防ぎましょう。
- スコープを使ってよく使うクエリパターンをカプセル化し、コントローラーをクリーンに保ちましょう。
- マスアサインメントの脆弱性を防ぐため、`fillable` か `guarded` を選択しましょう。
- ユーザー向けコンテンツには、復元の可能性を考慮してソフトデリートの利用を検討しましょう。

スキーマ・マイグレーション・シーダーが揃えば、コードとともにデータベースを安全に進化させるための確かな基盤が整います。
