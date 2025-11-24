# データベースガイド

Guren は Drizzle ORM と PostgreSQL を組み合わせて使います。ここではスキーマ定義、マイグレーション、シーダー、アプリコードからの日常的な利用方法を説明します。

## 設定の概要
- `config/database.ts`: DB 接続を生成しフレームワークへ公開。
- `drizzle.config.ts`: drizzle-kit の共通設定（スキーマパスやマイグレーション出力先など）。
- `db/schema.ts`: Drizzle のスキーマ定義（モデルとマイグレーションで使用）。
- `db/migrations/`: 生成または手書きの SQL マイグレーション。
- `db/seeders/`: サンプルデータを投入するシードスクリプト。

`.env` で `DATABASE_URL` を設定してください（既定値: `postgres://guren:guren@localhost:54322/guren`）。

## スキーマ定義
`db/schema.ts` で Drizzle のスキーマビルダーを使います:

```ts
import { pgTable, serial, text } from 'drizzle-orm/pg-core'

export const posts = pgTable('posts', {
  id: serial('id').primaryKey(),
  title: text('title').notNull(),
  body: text('body').notNull(),
})
```

テーブルはモデルの `static table` に紐付けて公開します。

```ts
// app/Models/Post.ts
import { Model } from '@guren/orm'
import { posts } from '@/db/schema'

export type PostRecord = typeof posts.$inferSelect

export class Post extends Model<PostRecord> {
  static override table = posts
  static override readonly recordType = {} as PostRecord
}

// `recordType` により Post.find() などの静的ヘルパーが Drizzle 由来の正確な型を返します。
```

## マイグレーションの生成
Guren CLI は drizzle-kit をラップし、Drizzle スキーマから SQL ファイルを生成します:

```bash
bunx guren make:migration --name add_posts_table
```

コマンドはプロジェクトルートの `drizzle.config.ts`（`.mts/.js/.mjs` も可）を参照し、スキーマパス・出力ディレクトリ・DB 方言を取得します。必要に応じて上書きも可能です:

```bash
bunx guren make:migration --schema ./custom/schema.ts --out ./custom/migrations
```

空のファイルを使いたい場合は手書きでも構いません（マイグレーションは SQL です）。

## マイグレーションの実行
`db/migrations/` に SQL ファイルを追加します（例: `0001_add_posts.sql`）。標準的な PostgreSQL 文を書きます:

```sql
CREATE TABLE posts (
  id serial PRIMARY KEY,
  title text NOT NULL,
  body text NOT NULL
);
```

適用は次の通り:

```bash
bun run db:migrate
```

スキャフォールド済みのスクリプトが未適用マイグレーションを順番に実行します。完了したものは追跡されるため再実行は安全です。

> [!NOTE]
> いったんどこかの環境に適用したマイグレーションは不変として扱ってください。修正が必要なら既存ファイルを編集せず、新しいマイグレーションを追加して履歴を一貫させます。

## データ投入（シード）
シードスクリプトを `db/seeders/` に置きます。典型的には `run()` をエクスポートする async 関数です:

```ts
// db/seeders/PostsSeeder.ts
import { Post } from '@/app/Models/Post'

export async function run() {
  await Post.create({ title: 'Hello', body: 'Welcome to Guren!' })
}
```

すべてのシードを実行するには:

```bash
bun run db:seed
```

開発・テスト・デモ環境のフィクスチャ投入に使ってください。

> [!CAUTION]
> シードはデータを変更・削除し得ます。意図した環境以外（特に本番）では実行しないでください。

### クイックテンプレート: モデル優先 vs RQB

どちらも型安全です。用途に応じて選びます。

```ts
// モデル優先（簡潔な CRUD と eager load）
import { Post } from '@/app/Models/Post'
const posts = await Post.withPaginate('author', { page: 1, perPage: 10, orderBy: [['id', 'desc']] })
```

```ts
// Drizzle RQB（JOIN/集計向き）
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

## ORM の使い方
`DatabaseProvider`（または `bootModels()` を呼ぶ独自プロバイダー）が起動時に走ると、すべてのモデルが設定済みの DB アダプターへアクセスできます。代表的なヘルパー:

```ts
await Post.all()            // 全件取得
await Post.find(id)         // 主キー検索（無ければ null）
await Post.create(payload)  // 挿入
await Post.where({ title }) // シンプルな where で絞り込み
```

### Drizzle 直接利用（RQB）と `Model.query()`

Guren は Drizzle を第一に考えています。リレーショナルクエリビルダーへ直接アクセスしても、モデルをエントリーポイントに使っても構いません。

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

// モデルを起点にしつつ RQB を併用
const recentViaModel = await Post.query(db)
  .orderBy(desc(schema.posts.createdAt))
  .limit(5)
```

手早い CRUD にはモデルヘルパーを、複雑な条件・JOIN・ドライバー固有 API には RQB（`db.select().from(...)` や `Model.query(db)`）を使い分けます。

### `where` で型安全なフィルタ

各モデルは Drizzle の推論結果を `recordType` として公開しているため、`where` ヘルパーはカラム名と値の形をコンパイル時にチェックします。値は単一、配列（`IN (...)` に展開）、NULL を受け取れます。

```ts
// 等価で絞り込み
await Post.where({ title: 'Hello' })

// 配列で IN (...) を生成
await Post.where({ id: [1, 2, 3] })

// undefined は無視されるため、任意フィルタの組み立てが容易
await Post.where({ published: true, authorId: user?.id ?? undefined })
```

存在しないキー（`Post.where({ foo: 'bar' })`）や型不一致（`Post.where({ id: 'oops' })`）は TypeScript が警告します。

### スコープなしで条件を組み立てる

Drizzle を優先する構成では、プレーン関数でフィルタを組み立てるのが簡潔です。

```ts
import { and, ilike, eq } from 'drizzle-orm'
import { getDatabase } from '@/config/database'
import { posts } from '@/db/schema'
import { Post } from '@/app/Models/Post'

type PostFilters = { search?: string; authorId?: number }

function buildPostFilters(filters: PostFilters) {
  const clauses = []
  if (filters.search) clauses.push(ilike(posts.title, `%${filters.search}%`))
  if (filters.authorId) clauses.push(eq(posts.authorId, filters.authorId))
  return clauses.length ? and(...clauses) : undefined
}

// モデルヘルパー + RQB のハイブリッド
const db = await getDatabase()
const where = buildPostFilters({ search: 'guren', authorId: 1 })
const rows = await Post.query(db).where(where).limit(10).execute()
```

### 並び替え `orderBy`

`Model.orderBy()` で結果を並び替えられます。カラム名は型安全で、いくつかの書式を受け付けます:

```ts
// 文字列は昇順が既定
await Post.orderBy('publishedAt')

// タプルで昇順/降順を指定
await Post.orderBy(['publishedAt', 'desc'])

// 複数カラムも配列で指定
await Post.orderBy([
  ['published', 'desc'],
  { column: 'title', direction: 'asc' },
])

// 並び替えとフィルタを組み合わせる
await Post.orderBy('publishedAt', { published: true })
```

内部では式を正規化し、設定された ORM アダプター（既定は Drizzle）が `orderBy()` へ変換します。さらに高度なクエリが必要なら、`config/database.ts` の DB インスタンスを直接使うか、モデルにヘルパーメソッドを追加してください。

### リレーションの定義

ORM にはよくある Eloquent 風のリレーションが付属します。モデルクラスに一度だけ宣言し、`static table` の近くに置くと見通しが良くなります。

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
export type PostAuthorSummary = Pick<UserRecord, 'id' | 'name'>

export class Post extends Model<PostRecord> {
  static override table = posts
  static override readonly recordType = {} as PostRecord
  static override relationTypes: { author: BelongsToRecord<PostAuthorSummary> } = {
    author: null,
  }
}

// app/Models/relations.ts
import { Post } from './Post'
import { User } from './User'

// モジュール循環を避けるため、両モデル定義の後でリレーションを記述
User.hasMany('posts', Post, 'authorId', 'id')
Post.belongsTo('author', User, 'authorId', 'id')
```

副作用を確実に走らせるため、アプリ起動時（例: `src/main.ts` 内）に一度だけ `relations.ts` をインポートします:

```ts
// src/main.ts
import './app/Models/relations'
```

- `hasMany(name, RelatedModel, foreignKey, localKey)`: 関連モデル側の外部キーと親側のキー（多くは `id`）を指定。
- `belongsTo(name, RelatedModel, foreignKey, ownerKey)`: 現在のモデルの外部キーと、関連モデル側の所有キーを結びつけます。
- `static relationTypes` で eager load の型を表現します。`Model.with('author')` などのヘルパーはこれらの型をマージし、コントローラ/ビューで完全に型付けされたデータを受け取れます（例: `{ author: PostAuthorSummary | null }`, `{ posts: PostRecord[] }`）。

### `with` で eager load

`Model.with()` を使うとリレーションを事前取得できます。各レコードの浅いコピーを返し、指定名のプロパティに関連データが入ります。

```ts
// ユーザーと投稿を一緒に読み込む
const users = await User.with('posts')

// フィルタと組み合わせる
const posts = await Post.with('author', { authorId: [1, 2] })

// posts[0].author は関連する UserRecord か null（belongsTo の場合）
```

`hasMany` は配列（未ヒットなら `[]`）、`belongsTo` は 1 件または `null` を返します。複数なら配列で渡します: `await User.with(['posts'])`。`where` や `orderBy` との併用も可能です。

## トランザクション
`config/database.ts` の DB インスタンスでトランザクションを実行します:

```ts
import { db } from '@/config/database'

await db.transaction(async (tx) => {
  await tx.insert(posts).values({ title, body })
})
```

モデルや Drizzle クエリに `tx` を渡し、原子性を保ちます。

## Tips
- マイグレーションは再実行可能な形に保ち、破壊的な文は避ける。
- 可変データはシードで扱い、マイグレーションは追記専用と考える。
- カラムやテーブルをリネームする場合は、データ移行用のマイグレーションを用意し、損失を避ける。

スキーマ・マイグレーション・シードが揃えば、コードとともにデータベースを安全に進化させられます。
