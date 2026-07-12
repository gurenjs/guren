# データベースガイド

Guren は Drizzle ORM と PostgreSQL を組み合わせて使います。このガイドでは、スキーマ定義、マイグレーション、シーダー、アプリケーションコードからの日常的な利用方法を説明します。

現在は PostgreSQL / SQLite / MySQL をサポートしています。

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

テーブルは `defineModel()` でモデルに公開するのが推奨です。

```ts
// app/Models/Post.ts
import { defineModel } from '@guren/orm'
import { posts } from '@/db/schema'

export type PostRecord = typeof posts.$inferSelect

export class Post extends defineModel(posts) {}

// Drizzle の推論型がそのまま Post.find() などの静的ヘルパーに流れます。
```

## SQLite サポート

Guren は Bun 組み込みの SQLite ドライバを使って、SQLite をそのままサポートします。新規プロジェクトはデフォルトで SQLite を使用するため、Docker や外部データベースのセットアップは不要です。

```ts
// config/database.ts
import { createSqliteDatabase } from '@guren/orm'

const database = createSqliteDatabase({
  migrationsFolder: new URL('../db/migrations', import.meta.url),
  seedersFolder: new URL('../db/seeders', import.meta.url),
  filename: () => process.env.DATABASE_URL ?? './data/guren.db',
})

export const { getDatabase, migrateDatabase, closeDatabase, configureOrm, seedDatabase } = database
```

SQLite アダプタは `createPostgresDatabase` と同じ API を持つため、切り替えはインポートと接続設定の変更だけで済みます。

> [!TIP]
> 開発とテストには SQLite を使い、本番では PostgreSQL に切り替えるのがおすすめです。ORM アダプタの抽象化により、モデルやクエリはそのまま動作します。

## MySQL サポート

MySQL（および互換データベース）を使う場合は `createMySqlDatabase` を使います。

```ts
// config/database.ts
import { createMySqlDatabase } from '@guren/orm'

const database = createMySqlDatabase({
  migrationsFolder: new URL('../db/migrations', import.meta.url),
  seedersFolder: new URL('../db/seeders', import.meta.url),
  connectionString: () => process.env.DATABASE_URL,
})

export const { getDatabase, migrateDatabase, closeDatabase, configureOrm, seedDatabase } = database
```

MySQL アダプタも PostgreSQL / SQLite と同じランタイム API（`getDatabase`, `migrateDatabase`, `configureOrm`, `seedDatabase`）を提供するため、切り替え時は主に import と接続設定の変更だけで済みます。

> [!TIP]
> Drizzle のリレーショナルクエリ (`db.query.<table>.findMany(...)`) を使いたい場合は、`drizzle-orm` の `defineRelations(schema, ...)` で生成した値を `relations` オプションに渡してください (RQB v2)。Guren の `Model` API ではこの設定は不要です。

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

## トランザクション

複数の書き込みを「全部成功 or 全部失敗」にしたい場合は `Model.transaction()` を使います。

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

より簡潔に書きたい場合は、トランザクション束縛スコープも使えます。

```ts
await Post.transaction(async (_trx, txPost) => {
  const post = await txPost.create({
    title: 'Scoped write',
    body: '手動で { trx } を渡さない',
  })

  await txPost.update({ id: post.id }, { status: 'published' })
})
```

## Fluent クエリビルダー

モデルは Fluent な `QueryBuilder` を公開しており、条件・ソート・制限をチェーンしてから実行できます。

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

## グローバルスコープ

グローバルスコープは、モデルのすべてのクエリに自動的に適用されるフィルタです。マルチテナンシーやソフトデリートなど、常に有効にしたい条件に使います。

```ts
// 現在のテナントで常にフィルタ
User.addGlobalScope('tenant', (q) => q.where('tenantId', currentTenantId()))

// 非アクティブユーザーを常に除外
User.addGlobalScope('active', (q) => q.where('active', true))
```

`all()`、`find()`、`where()`、`newQuery()` のすべてのクエリに自動適用されます。

### グローバルスコープの一時除外

特定のスコープを1回のクエリだけ除外できます。

```ts
const allUsers = await User.withoutGlobalScope('active').get()
```

すべてのグローバルスコープを除外する場合は以下のようにします。

```ts
const everyone = await User.withoutGlobalScopes().get()
```

スコープを完全に削除することもできます。

```ts
User.removeGlobalScope('active')
```

> [!TIP]
> `SoftDeletes` ミックスインは `'softDelete'` という名前のグローバルスコープを登録します。`withTrashed()` の代わりに `withoutGlobalScope('softDelete')` でも同じ結果が得られます。

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

## モデルオブザーバー

フックのロジックが複雑になったら、専用のオブザーバークラスに切り出せます。オブザーバーはフックと同じライフサイクルイベントに応答しますが、独立したファイルに配置できます。

```ts
// app/Observers/PostObserver.ts
import type { ModelObserver, PlainObject } from '@guren/orm'

export class PostObserver implements ModelObserver {
  creating(data: PlainObject) {
    data.slug = slugify(data.title as string)
  }

  created(data: PlainObject) {
    await notifySubscribers(data)
  }
}
```

モデルにオブザーバーを登録します。

```ts
import { PostObserver } from '@/app/Observers/PostObserver'

Post.observe(PostObserver)
```

before イベント（`creating`、`updating`、`deleting`、`saving`）で `false` を返すと操作が中止されます。インラインフックと同じ動作です。

フックとオブザーバーは共存できます。フックが先に実行され、その後にオブザーバーが実行されます。

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

## アクセサとミューテータ

アクセサはレコード読み取り時に仮想属性を計算します。ミューテータはデータベースへの書き込み前に値を変換します。

### アクセサ

レコード取得時に自動的に適用される計算プロパティを定義します。

```ts
export class User extends defineModel(users) {
  static accessors = {
    fullName: (record) => `${record.firstName} ${record.lastName}`,
    isAdmin: (record) => record.role === 'admin',
  }
}
```

```ts
const user = await User.find(1)
console.log(user.fullName)  // "John Doe"
```

アクセサは `all()`、`find()`、`where()`、`first()`、`paginate()` のすべての読み取りパスで実行されます。

### ミューテータ

データベースに保存する前に入力データを変換します。

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

ミューテータは `create()` と `update()` の両方で、フックやキャストのシリアライズより前に実行されます。

## シリアライゼーション

API レスポンスや Inertia プロップスでモデルレコードの表示を制御します。

### フィールドの非表示

機密フィールドをシリアライズ出力から除外します。

```ts
export class User extends defineModel(users) {
  static hidden = ['passwordHash', 'rememberToken']
}
```

```ts
const user = await User.find(1)
const json = User.serialize(user)
// { id: 1, name: "John", email: "john@example.com" }
// passwordHash と rememberToken は除外される
```

`hidden` に列挙したフィールドは `auth.user()` が返すレコードからも除去されるため、認証済みユーザーを公開する Inertia 共有 props や API レスポンスに漏れることはありません。詳細は[認証ガイド](./authentication.md)を参照してください。

### 表示フィールドのホワイトリスト

ブラックリストの代わりにホワイトリストを使用することもできます。

```ts
export class User extends defineModel(users) {
  static visible = ['id', 'name', 'email']
}
```

`visible` が設定されている場合、そのフィールドのみが表示されます。`visible` は `hidden` より優先されます。

### 仮想属性の追加

アクセサで計算された値をシリアライズ出力に含めます。

```ts
export class User extends defineModel(users) {
  static accessors = {
    fullName: (record) => `${record.firstName} ${record.lastName}`,
  }
  static appends = ['fullName']
  static hidden = ['firstName', 'lastName']
}
```

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
> `serialize()` と `serializeMany()` は Inertia ページプロップスや API レスポンスの構築に最適です。より複雑な変換には `JsonResource` と組み合わせてください。

## マスアサインメント保護

`fillable` または `guarded` で、`create()` や `update()` で設定可能なフィールドを制御できます。

```ts
export class Post extends Model<PostRecord> {
  static override table = posts
  static override readonly recordType = {} as PostRecord

  // これらのフィールドのみ一括代入可能
  static fillable = ['title', 'body', 'status']
}
```

`fillable` を設定すると、許可リスト外のフィールドを `create()` や `update()` に渡した場合、`MassAssignmentException`（`@guren/core` からエクスポート）がスローされます。エラーメッセージにはブロックされたフィールド名が含まれるため、タイプミスやインジェクションの試みが黙って破棄されて後から NOT NULL 違反として現れるのではなく、呼び出し箇所でその場で検出できます。

```ts
await Post.create({ title: 'Hello', body: '...', status: 'draft', authorId: 1 })
// MassAssignmentException: Post: mass assignment blocked for field(s) "authorId"
```

OAuth アカウント連携やシーダー、システムレコードなど、サーバーサイドで組み立てた信頼できるデータには、許可リストをバイパスする `forceCreate()` / `forceUpdate()` を使います。

```ts
const user = await User.forceCreate({
  name: profile.name,
  email: profile.email,
  passwordHash: `oauth:${provider}:${profile.id}`,
})

await User.forceUpdate({ id: user.id }, { emailVerifiedAt: new Date() })
```

> [!WARNING]
> `forceCreate()` / `forceUpdate()` はマスアサインメント保護を完全にスキップします。リクエスト入力をそのまま渡さないでください。

以前の「許可リスト外のフィールドを黙って破棄する」挙動に戻したい場合は、モデルごとにオプトアウトできます。

```ts
  static fillable = ['title', 'body', 'status']
  static strictFillable = false
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

`guarded` のフィールドは従来どおり黙って除外されます。例外をスローする厳格な挙動は、`fillable` を宣言したモデルにのみ適用されます。

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
import { defineModel, type BelongsToRecord } from '@guren/orm'
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

- `hasMany(name, RelatedModel, foreignKey, localKey)`: 関連モデルの外部キーと親側のローカルキー（通常 `id`）を指定します。
- `belongsTo(name, RelatedModel, foreignKey, ownerKey)`: 現在のモデルの外部キーと関連モデルの所有キーを結びつけます。
- `hasOne(name, RelatedModel, foreignKey, localKey)`: `hasMany` と同じように動作しますが、単一のレコードまたは `null` を返します。
- `belongsToMany(name, RelatedModel, pivotTable, foreignPivotKey, relatedPivotKey)`: ピボットテーブルを通じた多対多を処理します。
- `hasManyThrough(name, RelatedModel, ThroughModel, firstKey, secondKey)`: 中間モデルを経由してリモートリレーションにアクセスします。
- `morphMany(name, RelatedModel, morphName, localKey)`: 1対多のポリモーフィックリレーション。
- `morphTo(name, morphName)`: ポリモーフィックリレーションの逆方向。
- `static relationTypes` で eager load されるリレーションの型を記述します。`Model.with('author')` などのヘルパーがこれらの型をマージし、コントローラーやビューで完全に型付けされたリレーションデータを受け取れます。

### ポリモーフィックリレーション

ポリモーフィックリレーションを使うと、1つのリレーションで複数の親モデルに属することができます。例えば、投稿と動画の両方にコメントを付けられます。

関連テーブルに type/id カラムを定義します。

```ts
export const comments = sqliteTable('comments', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  body: text('body').notNull(),
  commentableType: text('commentable_type').notNull(),
  commentableId: integer('commentable_id').notNull(),
})
```

リレーションを登録します。

```ts
Post.morphMany('comments', Comment, 'commentable', 'id')
Video.morphMany('comments', Comment, 'commentable', 'id')
Comment.morphTo('commentable', 'commentable')

Model.morphMap = { Post, Video }
```

通常のリレーションと同じようにクエリできます。

```ts
const postWithComments = await Post.with('comments')
const comment = await Comment.findWith(1, 'commentable')
```

### `with` による eager loading

`Model.with()` を使って、一つ以上のリレーションを eager load できます。各レコードの浅いコピーを返し、設定された名前のプロパティにリレーションデータが挿入されます。

```ts
// ユーザーと投稿を一緒に読み込む
const users = await User.with('posts')

// eager loading とフィルタを組み合わせる
const posts = await Post.with('author', { authorId: [1, 2] })

// posts[0].author は関連する UserRecord か null（belongsTo の場合）
```

QueryBuilder 上でも eager loading が使えるので、フィルタやソートと組み合わせられます。

```ts
const activeUsers = await User.where('active', true)
  .with('posts')
  .orderBy('name')
  .get()

const user = await User.newQuery().with('posts').first()
```

ネストリレーションはドット記法で指定します。

```ts
const users = await User.with('posts.comments')
```

`hasMany` リレーションは配列として展開されます（マッチするものがない場合は `[]`）。`belongsTo` は単一の関連レコードまたは外部キーが存在しない場合は `null` を返します。複数のリレーションを配列で渡すこともできます: `await User.with(['posts'])`。

### リレーション件数の取得

`withCount()` は関連レコード本体をロードせずに `${name}Count` フィールドを付与します。件数だけ表示する一覧ページに最適です。

```ts
const users = await User.withCount('posts')        // users[0].postsCount は number
const posts = await Post.withCount(['comments', 'author'], { published: true })
```

`hasMany` / `hasOne` / `morphMany`（レコードごとの子件数）と `belongsTo`（0 または 1）に対応しています。

## ページネーション

一覧ページでは ORM の `PaginatedResult<T>` をそのまま `paginate()` に流し、resource output と page definition を揃えるのが標準です。

```ts
import { Controller, paginate, type PaginatedPageProps } from '@guren/core'
import { PostResource, type PostResourceData } from '@/app/Http/Resources/PostResource'
import { pages } from '@/.guren/pages.gen'

type PostsIndexProps = PaginatedPageProps<PostResourceData>

export default class PostController extends Controller {
  async index() {
    const page = Number(this.query('page', '1'))
    const result = await Post.paginate({ page, perPage: 15 })
    const paginator = paginate(result, { path: this.request.path ?? '/posts' })

    return this.inertia<PostsIndexProps>(pages.posts.Index, {
      data: result.data.map((post) => new PostResource(post).toJSON()),
      pagination: paginator,
    })
  }
}
```

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
