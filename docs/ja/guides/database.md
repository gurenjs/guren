# データベースガイド

Guren では、Drizzle のテーブルから作ったモデルを通してデータベースを読み書きします。クエリの API は Laravel の Eloquent に近い形で、スキーマから型が付きます。新しいアプリは SQLite を使うので準備は要らず、PostgreSQL、MySQL、Aurora Serverless へは設定を変えるだけで切り替えられます。

このページでは、データベースへの接続、スキーマの宣言とマイグレーション、データ投入（シード）までの準備を説明します。

## データベースへの接続

雛形は、`create-guren-app --db` で選んだドライバーに合わせて `config/database.ts` を書き出し、`createApp({ config })` にその定義を加えます。そのため、アプリは起動時に検証済みの環境変数を使って ORM を接続します。

どのドライバーも同じ関数（`getDatabase`、`migrateDatabase`、`closeDatabase`、`configureOrm`、`seedDatabase`、`resetDatabase`、`migrationStatus`）と `AppSeederContext` 型を持つので、切り替えてもモデルやクエリは変わりません。

| ドライバー | `--db` | `config/database.ts` のファクトリー |
|------------|--------|-------------------------------------|
| SQLite（デフォルト） | `sqlite` | `createSqliteDatabase` |
| PostgreSQL | `postgres` | `createPostgresDatabase` |
| MySQL | `mysql` | `createMySqlDatabase` |
| Aurora Serverless（AWS Data API） | なし（手で書く） | `createAwsDataApiDatabase` |
| Cloudflare D1 | なし（[Cloudflare ガイド](./cloudflare.md)を参照） | D1 用のファクトリー |

各ファクトリーは、接続の設定をリゾルバーで `config/env.ts` から読みます。リゾルバーが受け取る `context` 引数については[設定](./configuration.md#データベース接続)で説明しています。

### SQLite

新しいプロジェクトは Bun 組み込みのドライバーで SQLite を使うので、Docker や外部のデータベースは要りません。

```ts
// config/database.ts
import { createSqliteDatabase, defineDatabaseConfig, type SqliteSeederContext } from '@guren/core'
import env from './env.js'

const database = createSqliteDatabase({
  migrationsFolder: new URL('../db/migrations', import.meta.url),
  seedersFolder: new URL('../db/seeders', import.meta.url),
  filename: (context) => {
    const values = context?.env ?? env.parse(undefined, { mode: 'report' }).values
    // `bun test` は NODE_ENV=test を設定するので、テストは専用ファイルを使います。
    return process.env.NODE_ENV === 'test'
      ? values.TEST_DATABASE_URL ?? './data/guren.test.db'
      : values.DATABASE_URL ?? './data/guren.db'
  },
})

export const { getDatabase, migrateDatabase, closeDatabase, configureOrm, seedDatabase, resetDatabase, migrationStatus } = database

export type AppSeederContext = SqliteSeederContext

export default defineDatabaseConfig(database, {
  seedOnBoot: process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test',
})
```

`seedOnBoot` が true のときは、マイグレーションフォルダにマイグレーションがあれば、起動時にシーダーが実行されます。雛形では、`NODE_ENV` が `development`（`bun run dev` が設定します）か `test`（`bun test` が設定します）のときだけ有効にしています。`NODE_ENV` が未設定の場合を含め、それ以外の値ではシードしないので、`NODE_ENV` を付けずに起動したサーバーがシーダーのデモ用アカウントを作ることはありません。その環境では `bunx guren db:seed` を明示的に実行してください。テストでは別のファイルを使います（[テストガイド](./testing.md#テストデータベースの分離)を参照）。

以前に作ったアプリは `seedOnBoot: process.env.NODE_ENV !== 'production'` を渡していて、`NODE_ENV` が未設定のときにもシードします。`bunx guren doctor` はこれを警告して直し方を示しますが、ファイルは書き換えないので、手で直してください。比較の部分を `(process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test')` に置き換え、式の残りはそのまま残します。あわせて、`bun run dev` が `bin/serve.ts` を起動するスクリプトに `NODE_ENV=development` を付けてください（`"dev:server": "NODE_ENV=development bun --hot bin/serve.ts"`）。付けないと、`bun run dev` でシードされなくなります。

> [!TIP]
> 開発とテストでは SQLite を使い、本番では PostgreSQL に切り替える構成がおすすめです。モデルやクエリはそのまま動きます。

### PostgreSQL

`DATABASE_URL` は、雛形の `config/env.ts` で宣言済みです。

```ts
// config/database.ts
import { createPostgresDatabase, defineDatabaseConfig, type PostgresSeederContext } from '@guren/core'
import env from './env.js'

const database = createPostgresDatabase({
  migrationsFolder: new URL('../db/migrations', import.meta.url),
  seedersFolder: new URL('../db/seeders', import.meta.url),
  connectionString: (context) => (context?.env ?? env.parse(undefined, { mode: 'report' }).values).DATABASE_URL
    ?? 'postgres://guren:guren@localhost:54322/guren',
})

export const { getDatabase, migrateDatabase, closeDatabase, configureOrm, seedDatabase, resetDatabase, migrationStatus } = database

export type AppSeederContext = PostgresSeederContext

export default defineDatabaseConfig(database, {
  seedOnBoot: process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test',
})
```

テーブルは `pgTable` で宣言します。

```ts
// db/schema.ts
import { pgTable, serial, text, timestamp } from '@guren/orm/drizzle/pg'

export const posts = pgTable('posts', {
  id: serial('id').primaryKey(),
  title: text('title').notNull(),
  body: text('body').notNull(),
  status: text('status').notNull().default('draft'),
  publishedAt: timestamp('published_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
})
```

PostgreSQL では、タイムスタンプ列に必ず `{ withTimezone: true }` を付けてください。`timestamp without time zone` は、オフセットを持たない時計の表示だけを保存します。そのため、`defaultNow()` はデータベースセッションのタイムゾーンで値を書き込むのに、アプリはその値を UTC として読み戻し、アプリ以外のクライアントには別の時刻が見えてしまいます。

雛形はすでにこのオプションを付けて出力します。付け忘れた列があれば `bunx guren check`が警告します。ただし、この警告はスキーマを静的に解析して出すので、警告が出なくても、すべての列が正しいとは限りません。

### MySQL

MySQL（と互換データベース）では `createMySqlDatabase` を使います。

```ts
// config/database.ts
import { createMySqlDatabase, defineDatabaseConfig, type MySqlSeederContext } from '@guren/core'
import env from './env.js'

const database = createMySqlDatabase({
  migrationsFolder: new URL('../db/migrations', import.meta.url),
  seedersFolder: new URL('../db/seeders', import.meta.url),
  connectionString: (context) => (context?.env ?? env.parse(undefined, { mode: 'report' }).values).DATABASE_URL
    ?? 'mysql://guren:guren@localhost:33306/guren',
})

export const { getDatabase, migrateDatabase, closeDatabase, configureOrm, seedDatabase, resetDatabase, migrationStatus } = database

export type AppSeederContext = MySqlSeederContext

export default defineDatabaseConfig(database, {
  seedOnBoot: process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test',
})
```

### Aurora Serverless（AWS Data API）

AWS Lambda から、RDS Data API を有効にした Aurora Serverless v2 に接続する場合は、`createAwsDataApiDatabase` を使います。Data API は HTTP で通信するので、接続プールを管理する必要がなく、Lambda 関数を VPC 内に置く必要もありません。

```ts
// config/database.ts
import { createAwsDataApiDatabase, defineDatabaseConfig, type ConnectionContext } from '@guren/core'
import env from './env.js'

const values = (context?: ConnectionContext) => context?.env ?? env.parse(undefined, { mode: 'report' }).values

const database = createAwsDataApiDatabase({
  migrationsFolder: new URL('../db/migrations', import.meta.url),
  seedersFolder: new URL('../db/seeders', import.meta.url),
  // リゾルバーが undefined を返すと環境変数にフォールバックします:
  // DATABASE_NAME, DATABASE_RESOURCE_ARN, DATABASE_SECRET_ARN
  database: (context) => values(context).DATABASE_NAME,
  resourceArn: (context) => values(context).DATABASE_RESOURCE_ARN,
  secretArn: (context) => values(context).DATABASE_SECRET_ARN,
})

export const { getDatabase, migrateDatabase, closeDatabase, configureOrm, seedDatabase } = database

export default defineDatabaseConfig(database, {
  seedOnBoot: process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test',
})
```

3 つのキーは `config/env.ts` に宣言してください(例: `Env.string().optional()`。[設定](./configuration.md#環境変数を宣言する)を参照)。

ドライバーのパッケージもインストールしてください。

```bash
bun add @aws-sdk/client-rds-data
```

このアダプタもほかのドライバーと同じランタイム API を持ち、マイグレーションには標準の drizzle-kit のフォルダを使います。ただし、意図して変えている点が 1 つあります。`getDatabase()` は、未適用のマイグレーションを自動で実行**しません**。Lambda ではこの確認のために、コールドスタートのたびに Data API との往復が何回か順番に発生するからです。

マイグレーションはアプリの起動とは別に実行してください(ローカルでは `bun run db:migrate`、デプロイ後はコンソールハンドラを使います)。`migrateOnStart: true` を指定すれば、起動時に実行する以前の動きに戻せます。

Data API に対して `drizzle-kit generate`/`push` を実行する場合は、`drizzle.config.ts` に `driver: 'aws-data-api'` と、同じ `database`/`resourceArn`/`secretArn` を設定してください。

> [!NOTE]
> 認証には AWS SDK の標準のクレデンシャルチェーン(Lambda 上では IAM ロール、ローカルでは `AWS_PROFILE`)を使います。リージョンやクレデンシャルを明示的に指定したい場合は、`clientOptions` を渡してください。

## スキーマとマイグレーション

テーブルは `db/schema.ts` に、使うドライバー用の Drizzle のビルダーで宣言します。作ったばかりの SQLite のアプリには、`users` テーブルが 1 つあります。

```ts
// db/schema.ts
import { sqliteTable, integer, text } from '@guren/orm/drizzle/sqlite'

export const users = sqliteTable('users', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  email: text('email').notNull(),
  createdAt: text('created_at').notNull().$defaultFn(() => new Date().toISOString()),
})
```

スキーマを変えたら、そこからマイグレーションを生成して適用します。

```bash
bunx guren make:migration --name add_posts_table
bun run db:migrate
```

### マイグレーションの生成

このコマンドは、`drizzle.config.ts`、`.mts`、`.js`、`.mjs`、`.json` のうち、この順で最初に見つかったものから、スキーマのパス、出力ディレクトリ、DB 方言を読み取ります。パスは上書きすることもできます。

```bash
bunx guren make:migration --schema ./custom/schema.ts --out ./custom/migrations
```

上書きを指定すると、drizzle-kit に `--config` を渡せなくなります(drizzle-kit は `--config` とほかのフラグを同時に指定できません)。そこで Guren が設定ファイルを読み、`dialect`(と `driver`)をコマンドラインのフラグとして渡します。上書きしなかった項目には設定ファイルの値がそのまま使われるので、`--schema` だけを指定した場合でも、出力先は設定ファイルの `out` のままです。

設定ファイルの無いアプリでは `dialect` をどこからも読めないので、`--dialect` で明示してください。

```bash
bunx guren make:migration --dialect postgresql
```

`make:migration` は、アプリにインストールされている drizzle-kit を実行します。まずアプリの `node_modules` を探し、無ければ親ディレクトリの `node_modules`(ワークスペースで巻き上げられたもの)を探します。どこにも無ければ、`bun install` を実行するよう伝えて止まります。npm にある drizzle-kit は、アプリに入っているものとフラグが違う場合があるので、npm からは取得しません。

なお、設定ファイルで `schema` を配列にしている場合、`--schema` には値を 1 つしか渡せないので、上書きするときにはその配列を引き継げません。この場合、Guren はエラーで止まります(一部のテーブルだけを黙って生成してしまわないようにするためです)。`--schema` に 1 つのパスか glob を渡すか、上書きをやめて設定ファイルをそのまま使ってください。

> [!NOTE]
> どこかの環境に一度適用したマイグレーションは、変更しないでください。修正が必要なときは、新しいマイグレーションを追加します。

### マイグレーションが走るタイミング

マイグレーションは `db:migrate` を実行したとき以外にも適用されます。Data API アダプタと D1 アダプタ以外のドライバーは、最初に `getDatabase()` か `configureOrm()` が呼ばれたときに、未適用のマイグレーションを適用します。これは環境を問いません。`bun run dev` でも `bun test` でも、雛形の `Dockerfile` が `bun bin/serve.ts` で起動するコンテナでも、起動時にマイグレーションが走ります。そのため、新しいイメージを配るだけのデプロイでも、マイグレーション済みの状態で立ち上がります。

何かを適用した起動では、適用したものとその出どころが 1 行で表示されます。データベースが最新の状態なら、何も表示せずに立ち上がります。

この仕組みは便利な反面、残すつもりのなかったマイグレーションまでデータベースに適用されてしまいます。ジェネレーターは `db/migrations/` の下に新しいフォルダを未追跡のまま作りますが、`git switch` でも `git branch -D` でも未追跡のファイルは消えません。そのため、捨てたつもりのブランチで生成したマイグレーションが、ディスクに残ったまま適用される時を待つことになります。

ブランチと一緒に消えることは期待せず、`git clean -fd` で削除してください。何が消えるかは、先に `git clean -fdn` で確認できます。

フォルダを消して間に合うのは、まだどの起動でも適用されていない場合に限られます。ジェネレーターがファイルを書き換えている途中で dev サーバーがリロードすると、先にそちらで適用されてしまいます。そうなると、トラッカーにはどのフォルダにも対応しない行が残ります。マイグレーターはその行を読み飛ばすので、そのマイグレーションが作ったものはデータベースに残ったままになります。`db:status` はその行を orphaned(孤立)と表示し、起動のたびにマイグレーションの前に警告が出ます。

例外の 2 つのアダプタが起動時にマイグレーションしない理由は、それぞれ別です。Data API アダプタは、`migrateOnStart` を指定したときだけ起動時に実行します。未適用かどうかを確認するだけで、Lambda のコールドスタートのたびに往復が順番に発生するからです。

D1 には、実行時にマイグレーションする手段そのものがありません。マイグレーションは `wrangler d1 migrations apply <database>` で適用するものなので、`migrateDatabase()` は実行を試みず、そのことを伝えるだけです。

### 破壊的マイグレーション

drizzle-kit は、スキーマの差分から導かれる SQL をそのまま書き出します。1 回の編集でカラムを消して別のカラムを足すと、リネームかどうかを尋ねてきますが、尋ねられるのは対話できるターミナルで実行したときだけです。エージェントやスクリプトから実行すると `DROP COLUMN` が書き出され、次の起動でそのまま適用されます。Guren は未適用のマイグレーションを適用する前にすべて読み、次の文を報告します。

| 種類 | 対象 |
|---|---|
| `drop-table`、`drop-column`、`drop-schema` | `DROP TABLE`、`ALTER TABLE … DROP COLUMN`、`DROP SCHEMA` / `DROP DATABASE` |
| `alter-column-type` | PostgreSQL の `ALTER COLUMN … SET DATA TYPE`、MySQL の `MODIFY COLUMN` / `CHANGE COLUMN` |
| `table-rebuild` | SQLite の `__new_<table>` を作ってコピーし、元を消してリネームする手順。drizzle-kit はたいていのカラム変更をこの形で書きます。default や外部キーを足しただけのように、`CREATE TABLE __new_<table>` がすべてのカラムを同じ型か広い型でコピーする再作成は報告しません。ただし、外部キーが有効なまま実行される環境(Cloudflare D1)で、ほかのテーブルが `ON DELETE CASCADE`、`SET NULL`、`SET DEFAULT` で参照している場合は報告します。`DROP TABLE` で参照元の行が消えるか書き換わるためです |
| `rename` | `RENAME TO`、`RENAME COLUMN`、`RENAME TABLE` |
| `truncate`、`delete-all` | `TRUNCATE`(MySQL の `TRUNCATE PARTITION` を含む)と、`WHERE` のない `DELETE FROM` |
| `drop-partition` | MySQL の `ALTER TABLE … DROP PARTITION`。パーティションの行も消えます |
| `drop-cascade` | `DROP TYPE … CASCADE`、`DROP DOMAIN … CASCADE` など `CASCADE` 付きの `DROP` と、PostgreSQL の `DROP OWNED`。依存するカラムもまとめて消えます |
| `unreadable` | ガードが読めない SQL。閉じていない文字列・コメント・本体と、実行時に組み立てる SQL(連結や `format()` を `EXECUTE` するもの、`PREPARE … FROM @変数`)です |

ガードは、データベースと同じ規則で SQL を読みます。MySQL のバックスラッシュによるエスケープと `#` のコメント、PostgreSQL の `E'…'` とドル記号で囲んだ本体も、その規則どおりに扱います。方言は、起動時はファクトリーから、それ以外は `snapshot.json` から決まり、どちらからもわからなければすべての方言での読み方を合わせて判定します。`CREATE PROCEDURE`、`FUNCTION`、`TRIGGER` の本体と、文字列で書いた関数の本体の中の文も、ほかの文と同じように判定します。

リネームでは行は失われませんが、ひとつ前のデプロイは入れ替わるまで古い名前を読み続けます。型を広げるだけの変更(`varchar` を長くする、`smallint` を `integer` にする)は、drizzle-kit が各マイグレーションの横に書く `snapshot.json` で前後の型が読めれば報告しません。読めなければ報告します。また、未適用のマイグレーションのうち先に実行されるものが作るテーブルに対する文は報告しません。新しいデータベースでは履歴をまとめて適用するので、古い `DROP` があっても止まることはありません。

破壊的なマイグレーションを適用するには、その `migration.sql` の 1 行目に、レビューする人に向けた理由を添えて承認のコメントを書きます。

```sql
-- guren:allow-destructive: posts moved to articles in 20261012_copy_posts
DROP TABLE "posts";
```

コメントは 1 行目に置いてください。drizzle はファイルを `--> statement-breakpoint` で区切るので、最後の区切りのあとにコメントだけを置くと空の文になり、SQLite ではエラーになります。

ガードが働く場面は次のとおりです。

- `bunx guren db:migrate` は、承認のない文があれば環境を問わず適用を拒否します。`--dry-run` は適用せずに報告だけを行い、`--allow-destructive` はファイルを編集せずにその 1 回だけ適用します。
- 起動時の扱いはファクトリーのオプションで決まります。新しいアプリは `config/database.ts` で `destructiveMigrations: 'refuse'` を指定しているので、何も適用する前にエラーになります。指定のないアプリの既定値は `'warn'` で、該当する文を表示したうえで適用します。`GUREN_ALLOW_DESTRUCTIVE_MIGRATIONS=1` を設定すると、拒否される実行を 1 回だけ通せます。`db:reset` は空にしたデータベースにすべてを適用し直すので、判定の対象外です。
- `bunx guren check` と `bunx guren gate` は、まだ `main` に入っていないマイグレーション(ブランチでコミットしたもの、未コミットのもの、未追跡のもの)を判定します。エージェントの Stop hook と CI がマージ前に見つけられます。すでにリリース済みの `DROP` は報告しません。

```ts
const database = createPostgresDatabase({
  migrationsFolder: new URL('../db/migrations', import.meta.url),
  destructiveMigrations: 'refuse',
})
```

このコメントは、データを消してよいと人が判断した記録です。エージェントも SQL と同じように書けてしまうので、ハーネスは書く前にユーザーへ確認するよう指示しています。理由に無理があれば、レビューで指摘されます。

## データ投入（シード）

シードスクリプトは `db/seeders/` に置きます。よくある形のシーダーは、async の `run()` 関数を export します。

```ts
// db/seeders/PostsSeeder.ts
import { Post } from '@/app/Models/Post'

export async function run() {
  await Post.create({ title: 'Hello', body: 'Welcome to Guren!' })
}
```

すべてのシーダーは次のコマンドで実行します。

```bash
bun run db:seed
```

### Drizzle を直接使うシーダー

`defineSeeder()` を使うと、シーダーに Drizzle のデータベースそのものが渡されます。モデル層を通さずに一括で INSERT や UPSERT をしたいときに便利です。この `db` の型はダイアレクトごとに違うので、コンテキストには `AppSeederContext` の型注釈を付けてください。`AppSeederContext` は、アプリが設定しているデータベースに合わせた型の別名で、`config/database.ts` が export しています。

```ts
// db/seeders/PostsSeeder.ts
import { defineSeeder } from '@guren/core'
import type { AppSeederContext } from '../../config/database.js'
import { posts } from '../schema.js'

export default defineSeeder(async ({ db }: AppSeederContext) => {
  await db.insert(posts).values({ title: 'Hello', body: 'Welcome to Guren!' })
})
```

型引数なしの `SeederContext` は PostgreSQL 用なので、MySQL や SQLite ではアプリのスキーマが型エラーになります。このリリース以降に生成したアプリでは、`config/database.ts` が `AppSeederContext` を export しています。それより前に作ったアプリでは、ダイアレクトごとの別名(`PostgresSeederContext` / `MySqlSeederContext` / `SqliteSeederContext` / `AwsDataApiSeederContext`)を `@guren/core` から直接 import してください。

```ts
import { defineSeeder, type MySqlSeederContext } from '@guren/core'
```

> [!NOTE]
> D1 にはシーダーコンテキストがありません。`seedDatabase()` はシーダーを実行しないため、D1 のシードは `wrangler d1 execute <database> --file <seed.sql>` で行ってください。
## 次のステップ

- [モデル](./models.md): テーブルにモデルを定義し、行の取得・作成・更新を行う
- [リレーション](./relationships.md): モデル同士のリレーションを宣言し、eager load する

