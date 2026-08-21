# プラグイン作成ガイド

このガイドでは、Gurenプラグインの作成、テスト、公開の手順を解説します。

## プラグインとは？

Gurenプラグインは、`ServiceProvider`サブクラスをエクスポートするnpmパッケージです。ユーザーがプロバイダーを`createApp({ providers })`配列に追加すると、フレームワークがアプリケーション起動時に`register()`と`boot()`フックを呼び出します。

完全な仕様とルールについては、[プラグインコントラクト](../../../contributing/plugin-contract.md)を参照してください。

## ステップ1: 新しいパッケージを作成する

```bash
mkdir guren-plugin-analytics
cd guren-plugin-analytics
bun init
```

`package.json`を設定します:

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
- `@guren/core`は**peerDependency** -- ホストアプリケーションが提供します。
- `@guren/core`と`@guren/testing`はビルドとテスト用の**devDependencies**です。
- `gurenPlugin.compatibility`フィールドでサポートするGurenバージョンを宣言します。

## ステップ2: プラグインを定義する

`@guren/core`の`definePlugin()`ヘルパーを使用します。設定はクロージャに捕捉され、呼び出しごとに独立したプロバイダークラスを生成するため、同じプラグインを異なる設定で複数回登録できます:

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

初期化コストの高いプラグインは`deferred: true`と`provides: ['analytics']`を併せて指定すると、提供するサービスが最初に解決されるまでプロバイダーの読み込みを遅延できます。

`definePlugin()`でカバーできないライフサイクル制御が必要な場合は、従来通り`ServiceProvider`のサブクラスを直接エクスポートすることもできます。ただし設定をstaticプロパティに保存するのは避けてください。staticは共有されるため、プラグインを2回登録すると最初の設定が上書きされます。

## ステップ3: プラグインをエクスポートする

```typescript
// src/index.ts
export { analyticsPlugin, AnalyticsClient } from './plugin'
export type { AnalyticsConfig } from './plugin'
```

## ステップ4: プラグインメタデータを追加する

`package.json`に`gurenPlugin`フィールドを含める必要があります:

```json
{
  "gurenPlugin": {
    "compatibility": ">=1.0.0",
    "provider": "AnalyticsServiceProvider",
    "env": [
      { "key": "ANALYTICS_API_KEY", "comment": "Analytics service API key" }
    ],
    "publishes": [
      { "from": "stubs/analytics.ts", "to": "config/analytics.ts" }
    ]
  }
}
```

| フィールド | 用途 |
|-----------|------|
| `compatibility` | サポートするGurenバージョンのsemver範囲。`bunx guren plugin`のインストール時と`bunx guren doctor`で検証されます。 |
| `provider` | `bunx guren plugin`が`createApp({ providers })`に登録する名前付きクラスエクスポート。`definePlugin()`ファクトリの場合は省略します（手動登録）。 |
| `env` | インストール時にアプリの`.env.example`（`.env`が存在すればそちらにも）へ追記される環境変数キー。 |
| `publishes` | パッケージからアプリへコピーされるファイル（`config/`、`db/migrations/`、`resources/`のみ）。既存ファイルは`--force`なしでは上書きされません。 |

マニフェストは純粋なデータです — CLIはインストール中にプラグインのコードを一切実行しません。

### オプション: CLIコマンドを追加する

プラグインはマニフェストで宣言することで`guren` CLIにコマンドを追加できます:

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

エントリモジュールは、コマンド名をキーとするcittyコマンド定義のレコードをdefault exportします:

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

プラグインをアプリにインストールすると、`bunx guren analytics:flush`でコマンドが実行でき、`bunx guren --help`にも表示されます。コマンド名には`:`名前空間が必須で、ビルトインコマンド名が常に優先され、複数のプラグインが同じ名前を宣言した場合は警告とともに両方とも無効化されます。エントリモジュールがimportされるのは宣言したコマンドが実行される時（またはそのコマンド自身の`--help`を表示する時）だけで、ルートの一覧表示では実行されません。

## ステップ5: テストを書く

`@guren/testing`の`createPluginTestApp`と`assertPluginRegisters`を使用します:

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

テストを実行:

```bash
bun test src/plugin.test.ts
```

## ステップ6: ビルドする

[`tsdown`](https://tsdown.dev)を使用したビルドスクリプトを追加します(上の`main`/`types`に合わせて`dist/index.mjs`と`dist/index.d.mts`を出力します):

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

公開する前に、実際のGurenアプリにプラグインをリンクしてエンドツーエンドで検証しましょう:

```bash
# アプリのディレクトリで実行
bun add file:../guren-plugin-analytics
bunx guren plugin guren-plugin-analytics
```

`bun add file:`(および`link:`・`workspace:`プロトコル)は、パッケージをコピーするのではなく、プラグインのソースディレクトリへのシンボリックリンクとしてインストールします。プラグインの`package.json`に、ステップ1で`@guren/core`を`devDependencies`として追加した際の`node_modules`がまだ残っている場合、アプリは`@guren/core`を2つの別々のコピーとして読み込んでしまうことがあります — 1つはアプリ自身のインストール、もう1つはプラグイン経由です。これはランタイムでの重複モジュール警告や、コンパイル時の`Property 'bindings' is protected but type 'Container' is not a class derived from 'Container'`のようなTypeScriptエラーとして現れます。

この問題が発生した場合は、アプリにリンクする前にプラグインのパッケージディレクトリ内の`node_modules`を削除してください。プラグイン側に隠蔽するコピーがなくなれば、アプリ自身の`@guren/core`インストールがプラグインの`peerDependencies`を満たすようになります。公開済みのプラグインは`node_modules`を同梱しないため、これは公開前のローカル検証にのみ影響します。

## ステップ8: 公開する

```bash
bun run build
npm publish
```

## プラグインのインストール

公式（`@guren/plugin-*`）・コミュニティ（`guren-plugin-*`）を問わず、プラグインはCLI経由でインストールできます:

```bash
bunx guren plugin @guren/plugin-vercel
```

`plugin`コマンドは、依存が未インストールなら`bun add`でインストールし（`--no-install`でスキップ可能）、プラグインが宣言するGuren互換性を検証した上で（`--ignore-compatibility`で無視して登録可能）、プロバイダーのimport追加と`createApp({ providers })`への登録、マニフェストの`env`・`publishes`エントリの適用を行います。`--force`は公開済みファイルの上書きに使います。

> **注意:** 自動登録が対応しているのは、クラスベースのプロバイダーエクスポートと、公式のゼロ設定ファクトリプラグイン(`@guren/plugin-vercel`・`@guren/plugin-cloudflare`。`providers: [vercelPlugin()]`形式の呼び出しで登録されます)です。サードパーティの`definePlugin()`プラグインは設定を渡してファクトリを呼び出す必要があるため、下記のように`createApp({ providers })`へ手動で登録してください。

## Gurenアプリケーションでの使用方法

公開後、ユーザーはプラグインをインストールして登録します:

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

受信リクエストをすべてログに記録するシンプルなプラグイン:

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

テスト:

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

- **可能な場合は`register()`を同期的に保つ。** 両フックはasyncをサポートしますが、同期的な登録の方が高速です。
- **重い依存関係にはdeferredプロバイダーを使用する。** プラグインが大きなSDKを読み込む場合、必要な時にだけ初期化されるようにdeferredとしてマークしてください。
- **importではなくコンテナに依存する。** フレームワーク内部を直接importするのではなく、`this.container.make()`でサービスを解決してください。
- **複数のGurenバージョンに対してテストする。** CIマトリクスを使用して、サポートする最小バージョンと最新バージョンに対してテストスイートを実行してください。
- **登録するサービスをドキュメント化する。** ユーザーが自身のコードでサービスを解決できるよう、プラグインが提供するコンテナキーを明記してください。
