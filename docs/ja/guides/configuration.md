# 設定

Guren アプリの設定は `config/` に置きます。ここに置くファイルは次の 2 種類です。

- `config/env.ts` では、アプリが読む環境変数をすべて、型と必須かどうかを添えて宣言します。検証はアプリの起動時に 1 回だけ行われます。
- `config/<service>.ts`（`database`、`cache`、`mail`、`session` など）では、検証済みの値からサービスの設定を組み立てます。どのファイルも *config 定義* を default export します。

どちらも中身はただのデータで、import しただけでは接続も登録も起きません。接続や登録を行うのは `createApp()` です。

```ts
// src/app.ts
import { createApp } from '@guren/core'
import cache from '../config/cache.js'
import database from '../config/database.js'
import env from '../config/env.js'
import http from '../config/http.js'
import { registerWebRoutes } from '../routes/web.js'

const app = createApp({
  env,
  config: [database, http, cache],
  routes: registerWebRoutes,
})

export default app
```

`create-guren-app` が生成するのもこの形です。`config/env.ts` があるアプリで `guren add cache`、`guren add mail`、`guren add queue`、`guren add storage`、`guren add session`、`guren add oauth` を実行すると、それぞれの定義が `config` 配列に追加されます（[サービスプロバイダを使うアプリ](#サービスプロバイダを使うアプリ) を参照）。

## 環境変数を宣言する

`config/env.ts` は、`defineEnv()` で作ったスキーマを default export します。

```ts
// config/env.ts
import { defineEnv, Env, type InferEnv } from '@guren/core'

const env = defineEnv({
  APP_KEY: Env.string().secret().requiredInProduction()
    .describe('Signs cookies and encrypts session payloads.'),
  APP_URL: Env.url().requiredInProduction(),
  PORT: Env.port().default(3333),
  DATABASE_URL: Env.string().optional(),
  CACHE_STORE: Env.string().default('memory'),
  LOG_LEVEL: Env.enum(['debug', 'info', 'warn', 'error']).default('info'),
})

export default env

declare module '@guren/core' {
  interface AppEnv extends InferEnv<typeof env> {}
}
```

`declare module` のブロックを書いておくと、検証済みの値に型が付きます。定義の中で読んでも、コントローラの `this.make('env')` で読んでも、データベースの接続リゾルバで読んでも、型は同じです。

### 型

| ビルダー | 受け付ける値 | 値の型 |
|---|---|---|
| `Env.string()` | 任意 | `string` |
| `Env.url()` | `new URL()` で解釈できる文字列 | `string` |
| `Env.number()` | 有限の数値 | `number` |
| `Env.port()` | 1 から 65535 までの整数 | `number` |
| `Env.boolean()` | `true`、`false`、`1`、`0`（大文字小文字は区別しない） | `boolean` |
| `Env.enum([...])` | 列挙した文字列のどれか | それらの union 型 |
| `Env.custom(schema)` | 同期の Standard Schema（Zod、Valibot）が受け付ける値 | スキーマの出力型 |

### 必須かどうか

修飾子を付けていない変数は必須です。

| 修飾子 | 変数が未設定のとき |
|---|---|
| なし | 起動に失敗する |
| `.optional()` | 値は `undefined` |
| `.default(value)` | 値は `value` |
| `.requiredInProduction()` | `NODE_ENV` が `production` なら起動に失敗し、それ以外では `undefined` |

**空の値は未設定として扱います。** `.env` に `REDIS_URL=` と書いてあっても、その行がないのと同じです。デフォルトがあればその値が使われ、必須の変数なら起動に失敗します。`.env.example` には空の値がよく載っていますし、ホスティングの管理画面で値を消した変数も空になります。空文字列そのものに意味があるときは `.allowEmpty()` を付けてください。わざと表示名を空にしたメールの送信者名などがこれにあたります。

`.secret()` を付けた変数は、値がエラーメッセージに出なくなり、`guren env:example` でもキーだけが空の値で書き出されます。`.describe(text)` に渡した文は、`.env.example` のキーの上にコメントとして入ります。

### 検証に失敗したとき

起動が止まり、見つかった問題がまとめて表示されます。

```text
[guren] Invalid environment (2 problems):
  APP_KEY  required, not set
  PORT     "80a" is not a port
```

### 宣言できない変数

`NODE_ENV` と `GUREN_*` の変数は `process.env` から直接読みます。`defineEnv()` に含めると例外になります。デプロイ用のビルドは `process.env.NODE_ENV` という式そのものをバンドル時に置き換えるので、検証済みの値を経由するとこの置き換えが効かなくなるためです。また、`GUREN_MCP` や `GUREN_DOCS` などの `GUREN_*` はフレームワーク側のゲートなので、アプリのスキーマに左右されないようにしています。

## config 定義

定義は、検証済みの env を受け取ってサービスの設定を返す関数です。

```ts
// config/cache.ts
import { defineCacheConfig } from '@guren/core'
import { createRedisClient } from '@guren/core/redis'

export default defineCacheConfig((env) => ({
  default: env.CACHE_STORE,
  stores: {
    memory: { driver: 'memory' },
    // A function, so the client is built only when CACHE_STORE selects this store.
    redis: { driver: 'redis', client: () => createRedisClient({ url: env.REDIS_URL }) },
  },
}))
```

| ヘルパー | バインドするキー | 設定する内容 |
|---|---|---|
| `defineDatabaseConfig(database, { seedOnBoot })` | `database` | 起動時に ORM を接続する。`seedOnBoot` が true でマイグレーションがあれば、シードも実行する |
| `defineHttpConfig` | （HTTP カーネル） | `hostAuthorization` |
| `defineSessionConfig` | `session` | `SessionConfig` |
| `defineCacheConfig` | `cache` | `CacheConfig` |
| `defineMailConfig` | `mail` | `MailConfig` |
| `defineQueueConfig` | `queue` | `QueueConfig` |
| `defineStorageConfig` | `storage` | `StorageConfig` |
| `defineOAuthConfig` | `oauth` | `providers` と、任意で `stateStore` |

`createApp()` は、アプリのプロバイダより前に `ConfigServiceProvider` を登録します。このプロバイダは `register()` で env を検証して各定義のマネージャをバインドし、`boot()` ではほかのどのプロバイダよりも先に、定義の起動処理（データベース接続）を実行します。そのため、アプリのプロバイダは自分の `register()` の中で `cache` や `mail` を解決できますし、`config` 配列の並び順を気にする必要もありません。

**1 つのキーは 1 か所でしか設定できません。** 定義とプロバイダの両方が `cache` をバインドしていると、起動は両方の名前を挙げて失敗します。どちらか一方が黙って優先されることはありません。サービスを定義に移したら、元のプロバイダは削除してください。

ストア名のチェックは定義の中に書きます。マネージャはどんなストア名でも受け付け、実際に使われた時点で初めて例外を投げます。その時点が数時間後に実行されるキューのジョブだったりもするので、cache、queue、mail、storage の雛形では起動時に名前を確かめています。

```ts
// config/queue.ts
import { defineQueueConfig, MemoryDriver, SyncDriver } from '@guren/core'

const drivers = {
  sync: () => new SyncDriver(),
  memory: () => new MemoryDriver(),
}

export default defineQueueConfig((env) => {
  if (!Object.hasOwn(drivers, env.QUEUE_CONNECTION)) {
    throw new Error(
      `QUEUE_CONNECTION="${env.QUEUE_CONNECTION}" is not a declared driver. Declare it in config/queue.ts or use one of: ${Object.keys(drivers).join(', ')}.`,
    )
  }

  return { default: env.QUEUE_CONNECTION, drivers }
})
```

条件によって変わる設定は、コールバックの中にふつうのコードとして書きます。

```ts
// config/oauth.ts
import { defineOAuthConfig, type OAuthProviderConfig, createGitHubOAuthProviderConfig } from '@guren/core'

export default defineOAuthConfig((env) => {
  const providers: Record<string, OAuthProviderConfig> = {}

  if (env.OAUTH_GITHUB_CLIENT_ID && env.OAUTH_GITHUB_CLIENT_SECRET && env.OAUTH_GITHUB_REDIRECT_URI) {
    providers.github = createGitHubOAuthProviderConfig({
      clientId: env.OAUTH_GITHUB_CLIENT_ID,
      clientSecret: env.OAUTH_GITHUB_CLIENT_SECRET,
      redirectUri: env.OAUTH_GITHUB_REDIRECT_URI,
    })
  }

  return { providers }
})
```

### モジュールが持つ定義

[モジュール](./cli.md#アプリケーションモジュール)は、自分だけが使うサービスの定義を `modules/<name>/config/` に置き、自身の `defineModule({ config })` に並べられます。アプリの `createApp({ config })` に書く必要はありません。

```ts
// modules/auth/index.ts
import { defineModule } from '@guren/core'
import oauth from './config/oauth.js'
import { registerAuthRoutes } from './routes'

export const authModule = defineModule({
  name: 'auth',
  routes: registerAuthRoutes,
  config: [oauth],
})
```

ただし、コンテナはアプリ全体で 1 つです。モジュールの定義も、`createApp({ config })` に並べたときと同じく、アプリ全体で共通のキー（上の例では `oauth`）をバインドします。`ConfigServiceProvider` はまずアプリの定義をバインドし、続いて `createApp({ modules })` に並んだ順に各モジュールの定義をバインドします。アプリとモジュール、あるいは 2 つのモジュールが同じキーを定義していると、起動は両方の場所を挙げて失敗します。この重複は、起動する前に `guren check` でも報告されます。なお `guren check` がモジュールの `config` を配線済みとみなすのは、そのモジュールが `createApp({ modules })` に並んでいる場合に限ります。

## データベース接続

`config/database.ts` の名前付き export は消さずに残しておきます。`guren db:migrate` と `guren db:seed` が、アプリを起動せずにこれらを import して使うからです。接続リゾルバは、アプリの起動時には検証済みの env を受け取り、CLI から呼ばれたときは自分でスキーマを解析します。

```ts
// config/database.ts
import { createPostgresDatabase, defineDatabaseConfig } from '@guren/core'
import env from './env.js'

const database = createPostgresDatabase({
  migrationsFolder: new URL('../db/migrations', import.meta.url),
  seedersFolder: new URL('../db/seeders', import.meta.url),
  connectionString: (context) => (context?.env ?? env.parse(undefined, { mode: 'report' }).values).DATABASE_URL
    ?? 'postgres://guren:guren@localhost:54322/guren',
})

export const { getDatabase, migrateDatabase, closeDatabase, configureOrm, seedDatabase } = database

export default defineDatabaseConfig(database, { seedOnBoot: process.env.NODE_ENV !== 'production' })
```

`mode: 'report'` を指定すると、例外を投げずに検証できた値だけを返します。これで、本番で `guren db:migrate` を実行するときに、データベースへ接続したいだけなのに `APP_KEY` を求められる、ということがなくなります。

## `.env.example` をそろえる

変数の一覧は `config/env.ts` で管理し、`.env.example` にも同じキーが並ぶようにしておきます。

```bash
bunx guren env:example
```

このコマンドを実行すると、宣言してあるのに `.env.example` にないキーが末尾に追加されます。値にはデフォルト（シークレットなら空）が入り、説明はコメントになります。すでにある行は書かれたまま残ります。

```bash
bunx guren check --env
```

こちらは、2 つのファイルのキーがどちらか一方にしかなければ失敗するので、CI のゲートに使えます。オプションなしの `guren check` も同じ比較を行い、さらに `createApp({ config })` に並んでいない `config/<name>.ts` も報告します。

## コードから環境変数を読む

環境変数は `process.env` から読まず、コンテナから検証済みの値を取り出します。

```ts
import { Controller } from '@guren/core'

export default class AdminController extends Controller {
  async index() {
    const { ADMIN_EMAIL } = this.make('env')
    // ...
  }
}
```

雛形から作ったアプリでは、lint ルール `guren/no-unvalidated-env-read` が `app/`、`config/`、`routes/`、`src/`、`modules/` の中にある `process.env.X` を報告します。`X` が `NODE_ENV` や `GUREN_*` のときは対象外です。`bin/` と `drizzle.config.ts` はアプリより先に動くので、対象にしていません。意図して直接読む箇所では、その行でルールを無効にし、理由を書いておきます。

```ts
// oxlint-disable-next-line guren/no-unvalidated-env-read -- CI switch, not app config
const secureCookies = process.env.NODE_ENV === 'production' && !process.env.CI
```

## Cloudflare Workers

Workers では、wrangler の `vars` とシークレットはエントリポイントの `env` 引数で渡されるため、`process.env` に入っているとは限りません。`@guren/plugin-cloudflare` はアプリの起動前にこの引数をバインドし、スキーマはまずそこからキーを探して、なければ `process.env` を読みます。そのため、同じ `config/env.ts` をローカルでも Workers でも手を加えずに使えます。

## テスト

`TestApp.fromApp(app)` は実際の `src/app.ts` を定義ごと起動するので、機能テストも本番と同じ設定で動きます。

`process.env` を書き換えずに変数を 1 つだけ差し替えたいときは、スキーマと上書きする値を `TestApp.create()` に渡します。`envSource` は `process.env` より先に読まれ、`''` を渡したその変数は未設定として扱われます。

```ts
import { TestApp } from '@guren/testing'
import env from '../config/env.js'

const app = await TestApp.create({
  env,
  envSource: { CACHE_STORE: 'memory', APP_URL: '' },
  providers: [ReportProvider],
})
```

上書きした値が不正な場合、`create()` は `EnvValidationError` で reject します。

## サービスプロバイダを使うアプリ

config 定義ができる前に作られたアプリでは、サービスをプロバイダで設定しています（`CacheProvider`、`MailProvider`、`config/session.ts` を読む `SessionProvider` など）。これらはそのまま動くので、移行は必須ではありません。`bunx guren doctor --next` を実行すると、こうしたプロバイダを見つけて、書くべき定義を、プロバイダが読んでいた値と宣言が必要な変数を添えて表示してくれます。移すときは次の手順で進めます。

1. `config/env.ts` を追加し、プロバイダが読んでいる変数を宣言する。
2. 対応する `define*Config` ヘルパーで `config/<service>.ts` を書き、`process.env` の代わりに `env` から読む。
3. 同じ変更の中で、それを `createApp({ config })` に加え、プロバイダを `providers` から外す。
4. `bunx guren env:example` と `bunx guren check` を実行する。

`config/env.ts` があり、そのキーをバインドするプロバイダがなければ、以後 `guren add <service>` で追加するサービスは定義の形で生成されます。
