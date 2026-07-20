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
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
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
    "compatibility": ">=1.0.0"
  }
}
```

これにより、Guren（および他のツール）がプラグインがどのフレームワークバージョンに対応しているかを把握できます。

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

`tsup`を使用したビルドスクリプトを追加します:

```json
{
  "scripts": {
    "build": "tsup src/index.ts --format esm --dts",
    "test": "bun test"
  },
  "devDependencies": {
    "tsup": "^8.0.0"
  }
}
```

## ステップ7: 公開する

```bash
bun run build
npm publish
```

## 公式プラグインのインストール

公式プラグイン（`@guren/plugin-*`）はCLI経由でインストールでき、`src/app.ts`のパッチと必要なファイルの自動生成を行います:

```bash
bunx guren plugin @guren/plugin-vercel
bun add @guren/plugin-vercel
```

`plugin`コマンドがプロバイダーのimportを追加し、`createApp({ providers })`への登録を自動で行います。

> **注意:** 自動登録が現在対応しているのはクラスベースのプロバイダーエクスポートのみです。`definePlugin()`で作成したプラグインは設定を渡してファクトリを呼び出す必要があるため、下記のように`createApp({ providers })`へ手動で登録してください。

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
