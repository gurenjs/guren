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
    "compatibility": ">=0.2.0"
  },
  "peerDependencies": {
    "@guren/core": ">=0.2.0"
  },
  "devDependencies": {
    "@guren/core": "^0.2.0",
    "@guren/testing": "^0.2.0",
    "typescript": "^5.0.0"
  }
}
```

ポイント:
- `@guren/core`は**peerDependency** -- ホストアプリケーションが提供します。
- `@guren/core`と`@guren/testing`はビルドとテスト用の**devDependencies**です。
- `gurenPlugin.compatibility`フィールドでサポートするGurenバージョンを宣言します。

## ステップ2: ServiceProviderを作成する

```typescript
// src/AnalyticsServiceProvider.ts
import { ServiceProvider } from '@guren/core'

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

export class AnalyticsServiceProvider extends ServiceProvider {
  static config: AnalyticsConfig = { apiKey: '' }

  register(): void {
    this.container.singleton('analytics', () => {
      return new AnalyticsClient(AnalyticsServiceProvider.config)
    })
  }

  boot(): void {
    // 全プロバイダーの登録後にフレームワークイベントをサブスクライブ
    if (this.container.has('events')) {
      const events = this.container.make('events')
      const analytics = this.container.make<AnalyticsClient>('analytics')
      events.on('request.completed', (data: Record<string, unknown>) => {
        analytics.track('page_view', data)
      })
    }
  }
}
```

## ステップ3: プロバイダーをエクスポートする

```typescript
// src/index.ts
import { AnalyticsServiceProvider } from './AnalyticsServiceProvider'
import type { AnalyticsConfig } from './AnalyticsServiceProvider'

export { AnalyticsServiceProvider }
export type { AnalyticsConfig }

export function defineAnalyticsPlugin(config: AnalyticsConfig) {
  AnalyticsServiceProvider.config = config
  return AnalyticsServiceProvider
}
```

## ステップ4: プラグインメタデータを追加する

`package.json`に`gurenPlugin`フィールドを含める必要があります:

```json
{
  "gurenPlugin": {
    "compatibility": ">=0.2.0"
  }
}
```

これにより、Guren（および他のツール）がプラグインがどのフレームワークバージョンに対応しているかを把握できます。

## ステップ5: テストを書く

`@guren/testing`の`createPluginTestApp`と`assertPluginRegisters`を使用します:

```typescript
// src/AnalyticsServiceProvider.test.ts
import { describe, test, expect } from 'bun:test'
import { createPluginTestApp, assertPluginRegisters } from '@guren/testing'
import { AnalyticsServiceProvider, AnalyticsClient } from './AnalyticsServiceProvider'

describe('AnalyticsServiceProvider', () => {
  test('analyticsサービスが登録されること', async () => {
    AnalyticsServiceProvider.config = { apiKey: 'test-key' }

    const app = await createPluginTestApp([AnalyticsServiceProvider])

    // サービスがバインドされていることを確認
    assertPluginRegisters(app, ['analytics'])
  })

  test('AnalyticsClientインスタンスが解決されること', async () => {
    AnalyticsServiceProvider.config = { apiKey: 'test-key' }

    const app = await createPluginTestApp([AnalyticsServiceProvider])

    const client = app.container.make<AnalyticsClient>('analytics')
    expect(client).toBeInstanceOf(AnalyticsClient)
  })

  test('シングルトンとして登録されること', async () => {
    AnalyticsServiceProvider.config = { apiKey: 'test-key' }

    const app = await createPluginTestApp([AnalyticsServiceProvider])

    const first = app.container.make<AnalyticsClient>('analytics')
    const second = app.container.make<AnalyticsClient>('analytics')
    expect(first).toBe(second)
  })
})
```

テストを実行:

```bash
bun test src/AnalyticsServiceProvider.test.ts
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

## Gurenアプリケーションでの使用方法

公開後、ユーザーはプラグインをインストールして登録します:

```bash
bun add guren-plugin-analytics
```

```typescript
// src/app.ts
import { createApp } from '@guren/core'
import { defineAnalyticsPlugin } from 'guren-plugin-analytics'
import { registerWebRoutes } from '@/routes/web'

export const app = createApp({
  routes: registerWebRoutes,
  providers: [
    defineAnalyticsPlugin({
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
