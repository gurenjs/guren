# プラグイン作成ガイド

このガイドでは、Guren プラグインを作り、テストして公開するまでの手順を説明します。

## プラグインとは？

Guren プラグインは、`ServiceProvider` のサブクラスを export する npm パッケージです。ユーザーがそのプロバイダーを `createApp({ providers })` の配列に加えると、アプリケーションの起動時にフレームワークが `register()` と `boot()` のフックを呼び出します。

仕様とルールの全体は、[プラグインコントラクト](../../../contributing/plugin-contract.md)にまとめてあります。

## ステップ1: 新しいパッケージを作成する

```bash
mkdir guren-plugin-analytics
cd guren-plugin-analytics
bun init
```

`package.json` を次のように設定します。

```json
{
  "name": "guren-plugin-analytics",
  "version": "0.1.0",
  "type": "module",
  "main": "dist/index.mjs",
  "types": "dist/index.d.mts",
  "gurenPlugin": {
    "compatibility": ">=1.0.0"
  },
  "peerDependencies": {
    "@guren/core": ">=1.0.0"
  },
  "devDependencies": {
    "@guren/core": "^1.0.0",
    "@guren/testing": "^1.0.0",
    "typescript": "^5.0.0"
  }
}
```

ポイント:
- `@guren/core` は **peerDependency** にします。実際のパッケージはホスト側のアプリケーションが用意します。
- `@guren/core` と `@guren/testing` は、ビルドとテストに使う **devDependencies** です。
- `gurenPlugin.compatibility` フィールドには、サポートする Guren のバージョンを書きます。

## ステップ2: プラグインを定義する

プラグインは `@guren/core` の `definePlugin()` ヘルパーで定義します。設定はクロージャの中に保持され、呼び出すたびに別のプロバイダークラスが作られるので、同じプラグインを設定を変えて何度でも登録できます。

```typescript
// src/plugin.ts
import { definePlugin } from '@guren/core'

export interface AnalyticsConfig {
  apiKey: string
  endpoint?: string
  batchSize?: number
}

export class AnalyticsClient {
  constructor(private config: AnalyticsConfig) {}

  track(event: string, properties?: Record<string, unknown>): void {
    // 設定されたエンドポイントにアナリティクスイベントを送信
    console.log(`[Analytics] ${event}`, properties)
  }
}

export const analyticsPlugin = definePlugin<AnalyticsConfig>({
  name: 'analytics',

  register(container, config) {
    container.singleton('analytics', () => new AnalyticsClient(config))
  },

  boot(container) {
    // 全プロバイダーの登録後にフレームワークイベントをサブスクライブ
    if (container.has('events')) {
      const events = container.make('events')
      const analytics = container.make<AnalyticsClient>('analytics')
      events.on('request.completed', (data: Record<string, unknown>) => {
        analytics.track('page_view', data)
      })
    }
  },
})
```

初期化に時間のかかるプラグインでは、`deferred: true` と `provides: ['analytics']` を一緒に指定すると、提供するサービスが初めて解決されるときまでプロバイダーの読み込みを遅らせられます。`container.make()` は同期的に動くので、deferred なプラグインの `register()` ではサービスを同期的にバインドしてください（そうしないと `make()` が例外を投げます）。`boot()` は非同期でもかまいません。最初の解決の直後に実行されます。

`definePlugin()` では足りないほど細かくライフサイクルを制御したい場合は、`ServiceProvider` のサブクラスを直接 export してもかまいません。ただし、設定を static プロパティに保存するのは避けてください。static プロパティは共有されるので、プラグインを 2 回登録すると最初の設定が上書きされてしまいます。

## ステップ3: プラグインをエクスポートする

```typescript
// src/index.ts
export { analyticsPlugin, AnalyticsClient } from './plugin'
export type { AnalyticsConfig } from './plugin'
```

## ステップ4: プラグインメタデータを追加する

`package.json` には `gurenPlugin` フィールドが必要です。

```json
{
  "gurenPlugin": {
    "compatibility": ">=1.0.0",
    "provider": "AnalyticsServiceProvider",
    "env": [
      { "key": "ANALYTICS_API_KEY", "comment": "Analytics service API key", "secret": true },
      { "key": "ANALYTICS_BATCH_SIZE", "type": "number", "default": 50 }
    ],
    "publishes": [
      { "from": "stubs/analytics.ts", "to": "config/analytics.ts" }
    ]
  }
}
```

| フィールド | 用途 |
|-----------|------|
| `compatibility` | サポートする Guren のバージョンを表す semver 範囲。`bunx guren plugin` でのインストール時と `bunx guren doctor` で検証されます。 |
| `provider` | `bunx guren plugin` が `createApp({ providers })` に登録する、名前付きで export したクラス。`definePlugin()` のファクトリの場合は省略し、手動で登録します。 |
| `env` | アプリに必要な環境変数のキー。インストール時に `.env.example`（`.env` があればそちらにも）へ追記され、`config/env.ts` にも宣言されます。詳しくは後述します。 |
| `publishes` | パッケージからアプリへコピーするファイル（コピー先は `config/`、`db/migrations/`、`resources/` に限ります）。既存のファイルは、`--force` を付けない限り上書きされません。 |

マニフェストは中身がただのデータで、インストール中に CLI がプラグインのコードを実行することはありません。

### envエントリ

`bunx guren plugin` は、`env` の各エントリを 2 か所に反映します。まず、`.env.example`（なければ作成します）と、`.env` があればそちらにも `KEY=value` を追記します。ファイルですでに値を代入しているキーは追記しません。次に、アプリに `config/env.ts` があれば、その `defineEnv({ ... })` の呼び出しにキーを追加します。こうしておくと、アプリ自身の変数と同じように起動時に検証されます（[設定](./configuration.md#環境変数を宣言する)を参照）。`config/env.ts` ですでに宣言しているキーは、元の宣言をそのまま残します。`defineEnv({ ... })` の呼び出しがない `config/env.ts` は変更せず、手で宣言すべきキーをインストール時に表示します。

| エントリのフィールド | 効果 |
|-------------|--------|
| `key` | 変数名。大文字のスネークケースでないキーは読み飛ばされ、`GUREN_*` のキーがあるとインストールが失敗します。 |
| `value` | env ファイルの `=` の後ろに書かれる値。省略すると空になります。 |
| `comment` | キーの上に置かれる `#` のコメント行。宣言の `.describe()` にも使われます。 |
| `type` | ビルダーの種類。`string`（デフォルト）、`url`、`number`、`port`、`boolean`、`enum` のどれかです。 |
| `choices` | `type: "enum"` のキーが受け付ける文字列。`enum` では必須で、ほかの型で指定するとエラーになります。 |
| `default` | `.default(value)` になります。値は型に合わせてください（`number` と `port` は数値、`boolean` は真偽値、`enum` は `choices` のどれか）。 |
| `required` | `.optional()` を付けずに宣言するので、未設定のままだと起動に失敗します。`default` があるときは効果がありません。 |
| `secret` | `.secret()` になり、検証エラーのメッセージに値が出なくなります。 |

上のマニフェストからは、次の宣言が作られます。

```typescript
ANALYTICS_API_KEY: Env.string().optional().secret().describe('Analytics service API key'),
ANALYTICS_BATCH_SIZE: Env.number().default(50),
```

ビルダーが受け付けないエントリ（未知の `type`、型に合わない `default`、`value` や `comment` に含まれる改行）があると、パッケージを追加した直後にインストールが失敗します。このとき `src/app.ts`、env ファイル、`config/env.ts` はどれも変更されません。

### オプション: CLIコマンドを追加する

マニフェストで宣言しておけば、プラグインから `guren` CLI にコマンドを追加できます。

```json
{
  "gurenPlugin": {
    "commands": {
      "entry": "./dist/commands.mjs",
      "names": ["analytics:flush"]
    }
  }
}
```

エントリモジュールでは、コマンド名をキーにした citty のコマンド定義のレコードを default export します。

```typescript
// src/commands.ts
import { defineCommand } from 'citty'

export default {
  'analytics:flush': defineCommand({
    meta: { name: 'analytics:flush', description: 'キューされたイベントをフラッシュ' },
    async run() {
      // ...
    },
  }),
}
```

プラグインをアプリにインストールすると、`bunx guren analytics:flush` でコマンドを実行でき、`bunx guren --help` にも表示されるようになります。コマンド名には `:` で区切った名前空間が必要です。組み込みのコマンド名が常に優先され、複数のプラグインが同じ名前を宣言した場合は、警告を出したうえで両方とも無効になります。エントリモジュールが import されるのは、宣言したコマンドを実行するとき（またはそのコマンド自身の `--help` を表示するとき）だけで、トップレベルの一覧表示では読み込まれません。

## ステップ5: テストを書く

テストには `@guren/testing` の `createPluginTestApp` と `assertPluginRegisters` を使います。

```typescript
// src/plugin.test.ts
import { describe, test, expect } from 'bun:test'
import { createPluginTestApp, assertPluginRegisters } from '@guren/testing'
import { analyticsPlugin, AnalyticsClient } from './plugin'

describe('analyticsPlugin', () => {
  test('analyticsサービスが登録されること', async () => {
    const app = await createPluginTestApp([analyticsPlugin({ apiKey: 'test-key' })])

    // サービスがバインドされていることを確認
    assertPluginRegisters(app, ['analytics'])
  })

  test('AnalyticsClientインスタンスが解決されること', async () => {
    const app = await createPluginTestApp([analyticsPlugin({ apiKey: 'test-key' })])

    const client = app.container.make<AnalyticsClient>('analytics')
    expect(client).toBeInstanceOf(AnalyticsClient)
  })

  test('シングルトンとして登録されること', async () => {
    const app = await createPluginTestApp([analyticsPlugin({ apiKey: 'test-key' })])

    const first = app.container.make<AnalyticsClient>('analytics')
    const second = app.container.make<AnalyticsClient>('analytics')
    expect(first).toBe(second)
  })
})
```

テストを実行します。

```bash
bun test src/plugin.test.ts
```

## ステップ6: ビルドする

[`tsdown`](https://tsdown.dev) を使ったビルドスクリプトを追加します(上で指定した `main`/`types` に合わせて、`dist/index.mjs` と `dist/index.d.mts` を出力します)。

```json
{
  "scripts": {
    "build": "tsdown src/index.ts --dts",
    "test": "bun test"
  },
  "devDependencies": {
    "tsdown": "^0.22.0"
  }
}
```

## ステップ7: 公開前にローカルで動作確認する

公開する前に、実際の Guren アプリにプラグインをリンクして、一通り動くことを確かめておきましょう。

```bash
# アプリのディレクトリで実行
bun add file:../guren-plugin-analytics
bunx guren plugin guren-plugin-analytics
```

`bun add file:`(および `link:`・`workspace:` プロトコル)は、パッケージをコピーせず、プラグインのソースディレクトリへのシンボリックリンクとしてインストールします。このとき、ステップ1で `@guren/core` を `devDependencies` に加えたときの `node_modules` がプラグイン側に残っていると、アプリ自身がインストールしたものとプラグイン経由のものとで、`@guren/core` が 2 つの別のコピーとして読み込まれることがあります。そうなると、実行時には重複モジュールの警告が、コンパイル時には `Property 'bindings' is protected but type 'Container' is not a class derived from 'Container'` のような TypeScript のエラーが出ます。

この問題が起きたら、アプリにリンクする前に、プラグインのパッケージディレクトリにある `node_modules` を削除してください。プラグイン側に隠れたコピーがなくなれば、アプリ自身がインストールした `@guren/core` でプラグインの `peerDependencies` が満たされます。公開済みのプラグインには `node_modules` が含まれないので、この問題が起きるのは公開前のローカル検証のときだけです。

## ステップ8: 公開する

```bash
bun run build
npm publish
```

## プラグインのインストール

公式（`@guren/plugin-*`）でもコミュニティ製（`guren-plugin-*`）でも、プラグインは CLI からインストールできます。

```bash
bunx guren plugin @guren/plugin-vercel
```

`plugin` コマンドは、依存がまだインストールされていなければ `bun add` でインストールし（`--no-install` で省略できます）、プラグインが宣言している Guren との互換性を検証します（`--ignore-compatibility` を付けると、互換性を無視して登録できます）。そのうえでプロバイダーの import を追加して `createApp({ providers })` に登録し、マニフェストの `env`（[envエントリ](#envエントリ)を参照）と `publishes` のエントリを適用します。公開済みのファイルを上書きしたいときは `--force` を付けます。

> **注意:** 自動登録に対応しているのは、クラスベースで export したプロバイダーと、設定の要らない公式のファクトリプラグイン(`@guren/plugin-vercel`・`@guren/plugin-cloudflare`。`providers: [vercelPlugin()]` の形の呼び出しで登録されます)です。サードパーティの `definePlugin()` プラグインは設定を渡してファクトリを呼ぶ必要があるので、下の例のように `createApp({ providers })` へ手動で登録してください。

設定を受け取る公式のファクトリプラグインも同様で、`@guren/plugin-agents` がこれにあたります。`agentsPlugin(agents)` は `config/agents.ts` の永続エージェントレジストリを引数に取るので、`guren plugin` が行うのはインストールと互換性レンジの検証までです。登録は自分で書いてください([永続エージェント](./durable-agents.md)を参照)。

## Gurenアプリケーションでの使用方法

公開したプラグインは、ユーザーが次のようにインストールして登録します。

```bash
bun add guren-plugin-analytics
```

```typescript
// src/app.ts
import { createApp } from '@guren/core'
import { analyticsPlugin } from 'guren-plugin-analytics'
import { registerWebRoutes } from '@/routes/web'

export const app = createApp({
  routes: registerWebRoutes,
  providers: [
    analyticsPlugin({
      apiKey: process.env.ANALYTICS_API_KEY!,
      endpoint: 'https://analytics.example.com',
    }),
  ],
})
```

## 完全な例: リクエストロガープラグイン

受け取ったリクエストをすべてログに記録する、シンプルなプラグインの例です。

```typescript
// src/RequestLoggerProvider.ts
import { ServiceProvider } from '@guren/core'
import type { Hono, MiddlewareHandler } from 'hono'

export class RequestLoggerProvider extends ServiceProvider {
  register(): void {
    this.container.singleton('request-logger', () => {
      return {
        requests: [] as Array<{ method: string; path: string; timestamp: number }>,
      }
    })
  }

  boot(): void {
    const hono = this.container.make<Hono>('hono')
    const logger = this.container.make<{ requests: Array<{ method: string; path: string; timestamp: number }> }>('request-logger')

    const middleware: MiddlewareHandler = async (c, next) => {
      logger.requests.push({
        method: c.req.method,
        path: c.req.path,
        timestamp: Date.now(),
      })
      await next()
    }

    hono.use('*', middleware)
  }
}
```

テストは次のとおりです。

```typescript
import { describe, test, expect } from 'bun:test'
import { createPluginTestApp, assertPluginRegisters } from '@guren/testing'
import { RequestLoggerProvider } from './RequestLoggerProvider'

describe('RequestLoggerProvider', () => {
  test('request-loggerサービスが登録されること', async () => {
    const app = await createPluginTestApp([RequestLoggerProvider])
    assertPluginRegisters(app, ['request-logger'])
  })

  test('空のリクエストログで初期化されること', async () => {
    const app = await createPluginTestApp([RequestLoggerProvider])
    const logger = app.container.make<{ requests: unknown[] }>('request-logger')
    expect(logger.requests).toHaveLength(0)
  })
})
```

## ヒント

- **`register()` はなるべく同期のままにする。** どちらのフックも async にできますが、登録は同期のほうが速く終わります。
- **重い依存を持つなら deferred プロバイダーにする。** 大きな SDK を読み込むプラグインは deferred を指定し、必要になったときにだけ初期化されるようにしてください。
- **import ではなくコンテナに頼る。** フレームワークの内部を直接 import せず、`this.container.make()` でサービスを解決してください。
- **複数の Guren バージョンでテストする。** CI のマトリクスを使い、サポートする最小バージョンと最新バージョンの両方でテストスイートを走らせてください。
- **登録するサービスをドキュメントに書く。** 利用者が自分のコードでサービスを解決できるように、プラグインが提供するコンテナのキーを明記してください。
