# データベースガイド

Guren は Drizzle ORM と PostgreSQL を組み合わせて使います。このガイドでは、スキーマ定義、マイグレーション、シーダー、アプリケーションコードからの日常的な利用方法を説明します。

現在は PostgreSQL / SQLite / MySQL / Aurora Serverless（AWS Data API）をサポートしています。

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
  publishedAt: timestamp('published_at', { withTimezone: true }),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
})
```

PostgreSQL では、タイムスタンプ列に必ず `{ withTimezone: true }` を付けてください。
`timestamp without time zone` はオフセットを持たない壁時計を保存するため、
`defaultNow()` はデータベースセッションのタイムゾーンで書き込む一方でアプリは
UTC として読み戻し、アプリ以外のクライアントは異なる instant を見ることになります。
スキャフォールドは既にこれを出力します。付け忘れた列は `bunx guren check`
が警告します。この警告はスキーマを静的に解析するため、読み取れた範囲のみを
報告します。警告が出ないことは「検出されなかった」であって、保証ではありません。

テーブルは `defineModel()` でモデルに公開するのが推奨です。

```ts
// app/Models/Post.ts
import { defineModel } from '@guren/orm'
import { posts } from '@/db/schema'

export type PostRecord = typeof posts.$inferSelect

export class Post extends defineModel(posts) {}

// Drizzle の推論型がそのまま Post.find() などの静的ヘルパーに流れます。
```

### create のペイロードを整える

`defineModel()` が `create()` 用に推論する型は、データベース側のデフォルト値を持たない全カラムを必須にします。モデル自身が値を導出するカラムがある場合は、型を手書きせず同じ呼び出しで指定します。

```ts
export class User extends defineModel(users, {
  base: AuthenticatableModel,
  optionalOnCreate: ['passwordHash'],  // password から生成するので渡さなくてよい
  requireOnCreate: ['password'],     // 代わりに仮想フィールドを必須にする
}) {}
```

`optionalOnCreate` はカラムを任意にします（型はそのままで、渡さなくてよくなります）。`requireOnCreate` は逆にフィールドを必須にし、テーブルのカラム（Drizzle はデフォルト値付きを任意にします）と `base` が提供するフィールドの両方を受け付けます。どちらも型レベルのみの指定で、実際のキーと照合されるためタイポはコンパイルエラーになります。

どちらもペイロードを閉じるわけではありません。create の型は未知のキーを `unknown` として受け入れるため、意図しないフィールドを実行時に弾くのは引き続き `fillable` です。

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

## Aurora Serverless（AWS Data API）サポート

AWS Lambda 上で RDS Data API を有効にした Aurora Serverless v2 に接続する場合は `createAwsDataApiDatabase` を使います。Data API は HTTP ベースのため、接続プールの管理が不要で、Lambda 関数を VPC 内に配置する必要もありません。

```ts
// config/database.ts
import { createAwsDataApiDatabase } from '@guren/orm'

const database = createAwsDataApiDatabase({
  migrationsFolder: new URL('../db/migrations', import.meta.url),
  seedersFolder: new URL('../db/seeders', import.meta.url),
  // 各設定は環境変数へのフォールバックもあります:
  // DATABASE_NAME, DATABASE_RESOURCE_ARN, DATABASE_SECRET_ARN
  database: () => process.env.DATABASE_NAME,
  resourceArn: () => process.env.DATABASE_RESOURCE_ARN,
  secretArn: () => process.env.DATABASE_SECRET_ARN,
})

export const { getDatabase, migrateDatabase, closeDatabase, configureOrm, seedDatabase } = database
```

ドライバパッケージも合わせてインストールしてください:

```bash
bun add @aws-sdk/client-rds-data
```

このアダプタも他のドライバと同じランタイム API を提供し、マイグレーションは標準の drizzle-kit フォルダを使用します。意図的な違いが 1 つあります: `getDatabase()` は保留中のマイグレーションを自動実行**しません** — Lambda ではこのチェックがコールドスタートのたびに直列の Data API 往復を数回消費するためです。マイグレーションは帯域外で実行するか（ローカルでは `bun run db:migrate`、デプロイ後はコンソールハンドラ）、`migrateOnStart: true` で従来の挙動に戻せます。Data API に対して `drizzle-kit generate`/`push` を実行する場合は、`drizzle.config.ts` に `driver: 'aws-data-api'` と同じ `database`/`resourceArn`/`secretArn` を設定してください。

> [!NOTE]
> 認証は AWS SDK の標準クレデンシャルチェーン（Lambda 上では IAM ロール、ローカルでは `AWS_PROFILE`）を使用します。リージョンやクレデンシャルを明示的に指定する場合は `clientOptions` を渡してください。

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

### Drizzle を直接使うシーダー

`defineSeeder()` はシーダーに Drizzle のデータベースそのものを渡します。モデル層を介さない一括 INSERT や UPSERT に便利です。この `db` の型はダイアレクトごとに異なるため、コンテキストには `AppSeederContext` を注釈してください。アプリが設定しているデータベースに対応する別名を `config/database.ts` がエクスポートしています。

```ts
// db/seeders/PostsSeeder.ts
import { defineSeeder } from '@guren/core'
import type { AppSeederContext } from '../../config/database.js'
import { posts } from '../schema.js'

export default defineSeeder(async ({ db }: AppSeederContext) => {
  await db.insert(posts).values({ title: 'Hello', body: 'Welcome to Guren!' })
})
```

型引数なしの `SeederContext` は PostgreSQL を意味するため、MySQL や SQLite では自分のスキーマが型エラーになります。`AppSeederContext` は、このリリース以降にスキャフォールドしたアプリの `config/database.ts` がエクスポートします。それ以前に作成したアプリでは、ダイアレクトの別名（`PostgresSeederContext` / `MySqlSeederContext` / `SqliteSeederContext` / `AwsDataApiSeederContext`）を `@guren/core` から直接インポートしてください。

```ts
import { defineSeeder, type MySqlSeederContext } from '@guren/core'
```

> [!NOTE]
> D1 にはシーダーコンテキストがありません。`seedDatabase()` はシーダーを実行しないため、D1 のシードは `wrangler d1 execute <database> --file <seed.sql>` で行ってください。

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
import { defineModel, type QueryBuilder } from '@guren/orm'
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

すべてのクエリ入口に自動適用されます — `all()`、`find()`、`first()`、`where()` と
その `whereIn` / `whereNull` / `select` 系、`scope()`、`orderBy()`、`paginate()`
（行だけでなく件数にも）、`newQuery()`、そしてリレーションを eager load するクエリ
（この場合は*関連先*モデルのスコープが適用されます）。

書き込みも同様です。`update()`・`forceUpdate()`・`delete()` は `where` に同じスコープを
足すため、`tenant` スコープがあれば、あるテナントが別テナントの行を「読む」だけでなく
「更新・削除する」ことも防げます。

これを回避する唯一の方法は、下記のとおり明示的に指定することです。

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
import { defineModel } from '@guren/orm'
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
import { SoftDeletes, defineModel } from '@guren/orm'
import { posts } from '@/db/schema'

export class Post extends SoftDeletes(defineModel(posts)) {}
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

アクセサはレコード読み取り時に仮想属性を計算します。ミューテータはデータベースへの書き込み前に値を変換します。

### アクセサ

レコード取得時に自動的に適用される計算プロパティを定義します。

```ts
export class User extends defineModel(users, {
  accessors: {
    // `record` はテーブルのレコード型 — フィールド名のタイプミスはコンパイルエラー
    fullName: (record) => `${record.firstName} ${record.lastName}`,
    isAdmin: (record) => record.role === 'admin',
  },
}) {}
```

（クラス側の `static accessors = { ... }` も使えますが、`record` 引数には型が付きません。）

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
export class User extends defineModel(users, {
  hidden: ['passwordHash', 'rememberToken'],
}) {}
```

`fillable` と同じく、オプションはテーブルのカラム名に対して型チェックされます。`static hidden = [...]` も引き続き使えます。

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
export class User extends defineModel(users, {
  visible: ['id', 'name', 'email'],
}) {}
```

`visible` が設定されている場合、そのフィールドのみが表示されます。`visible` は `hidden` より優先されます。

### 仮想属性の追加

アクセサで計算された値をシリアライズ出力に含めます。

```ts
export class User extends defineModel(users, {
  accessors: {
    fullName: (record) => `${record.firstName} ${record.lastName}`,
  },
  appends: ['fullName'],
  hidden: ['firstName', 'lastName'],
}) {}
```

`appends` に書けるのは同じオプションの `accessors` で宣言した名前だけです — 未宣言の名前はコンパイルエラーになります。

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

`fillable` で、`create()` や `update()` で設定可能なフィールドを制御できます。

```ts
export class Post extends defineModel(posts, {
  // これらのフィールドのみ一括代入可能。
  // テーブルのカラム名に対して型チェックされ、タイプミスはコンパイルエラーになる
  fillable: ['title', 'body', 'status'],
}) {}
```

クラス側に `static fillable = ['title', 'body', 'status']` と宣言しても同じ許可リストになります。オプション形は TypeScript が全フィールド名をテーブルと照合するため推奨です（サブクラスの `static` 宣言はオプションを上書きします）。`fillable` を設定すると、許可リスト外のフィールドを `create()` や `update()` に渡した場合、`MassAssignmentException`（`@guren/core` からエクスポート）がスローされます。エラーメッセージにはブロックされたフィールド名が含まれるため、タイプミスやインジェクションの試みが黙って破棄されて後から NOT NULL 違反として現れるのではなく、呼び出し箇所でその場で検出できます。

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

`fillable` の設定に関係なく、次の2つの保護が常に適用されます。

- 主キー（`id`）は一括代入の入力から常に黙って除外されます。フォームが `id` をラウンドトリップしても書き込み先は変わりません。
- `AuthenticatableModel` を継承するモデルでは、認証情報のカラム（パスワードハッシュとリメンバートークン）は常に例外をスローします。`fillable` に列挙しても許可されません。平文の `password` を渡してモデルにハッシュ化させるか、信頼できるサーバーサイドの値には `forceCreate()` / `forceUpdate()` を使ってください。

`fillable` が未設定の場合、`id` と拒否された認証情報カラムを除くすべてのカラムが代入可能になります。ユーザー入力を受け取るモデルには必ず宣言してください。

## リレーションの定義

ORM には、一般的な Eloquent スタイルのリレーション層が組み込まれています。モデルクラスにリレーションを一度だけ宣言します。`static table` の近くに置くと見通しがよくなります。

### hasMany / belongsTo

```ts
// app/Models/User.ts
import { defineModel, type HasManyRecord } from '@guren/orm'
import { users } from '@/db/schema'
import type { PostRecord } from '@/app/Models/Post'

export type UserRecord = typeof users.$inferSelect

export class User extends defineModel(users) {
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

ネストパスの型は `relationTypes` の先頭セグメントのみが反映されます。ネスト先まで型を効かせたい場合は、先頭リレーションのレコード型の中にネストした形を宣言してください。

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
> `relationTypes` と照合されるのは先頭セグメント(上記の `posts`)だけです。最初のドット以降は検証されない文字列なので、タイプミスや不正な末尾(`'posts.'`・`'posts..comments'`・`'posts.typo'`)もコンパイルは通ります。ランタイムでは末尾が未知のリレーション名であればエラーになりますが、それはローダーが実際にロード済みの子レコードへ再帰した場合に限られます。すべてのレコードで先頭リレーションが 0 件しかロードされなければ、末尾は一切検査されず静かに何もせず終わります。`morphTo` リレーションを経由したネストは常にランタイムでエラーになりますが、この制約も型レベルでは表現されていません。

`BelongsToRecord<T>` は常に `T | null` です。外部キーが `NOT NULL` で親レコードの存在が保証される場合は、代わりに `BelongsToRequiredRecord<T>` で宣言できます。`declare` 修飾子を使えばランタイム用のプレースホルダ値も不要です。

```ts
export class Comment extends defineModel(comments) {
  declare static relationTypes: {
    author: BelongsToRequiredRecord<UserRecord>
  }
}

const comments = await Comment.with('author')
comments[0].author.name // null チェック不要
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
- マスアサインメントの脆弱性を防ぐため、ユーザー入力を受け取るモデルには `fillable` を宣言しましょう。
- ユーザー向けコンテンツには、復元の可能性を考慮してソフトデリートの利用を検討しましょう。

スキーマ・マイグレーション・シーダーが揃えば、コードとともにデータベースを安全に進化させるための確かな基盤が整います。
