# テストガイド

Guren には 2 つのスタイルの自動テストがあります。

- **フレームワークのユニット/統合テスト**: `packages/server/tests` などパッケージ内にあり、Bun の `bun test` で実行。
- **サンプルアプリのテスト**: 例として `examples/blog` は Vitest + jsdom を使用し、ブラウザと同等の React レンダリングを行います。

ランナーの想定が異なるため、それぞれに合った方法で実行します:

```bash
# フレームワークパッケージ（Bun ランナー）
bun test packages/server/tests

# ブログ例（Vitest + jsdom）
bun run --cwd examples/blog test
```

### フレームワーク向け Bun テストを書く

`bun:test` の組み込みアサーションを利用し、ルーティングレジストリや HTTP ヘルパーなど低レベルユーティリティを、アプリ全体を起動せず検証します。

パターン例:

- コントローラを生成し、アクション呼び出し前にスタブした Hono コンテキストを `setContext(ctx)` で渡す。
- 成功/失敗パスをカバーする軽量フェイク（インメモリ ORM アダプターなど）を使う。
- コードを持つパッケージ内で焦点の定まったユニットテストを書く。内側のループを速く保つため高レベルアプリテストは最小限に。

スタートポイントが欲しい場合は生成コマンドを使います:

```bash
# tests/ 配下に Bun スタイルのテストを生成
bunx guren make:test server/http/request --runner bun

# SPA コード向け Vitest スタイルのテスト
bunx guren make:test blog/pages/Login
```

デフォルトは Vitest で、`--runner bun` で切り替えます。

### `@guren/testing` でコントローラをテストする

`@guren/testing` にはコントローラ向けヘルパーが用意されています:

- `createControllerContext(url, init?)` — コントローラ用の Hono コンテキストを構築。
- `createGurenControllerModule()` — Vitest 実行時に `guren` パッケージをモックし、コントローラを単体でテスト可能に。
- `createControllerModuleMock()` — `@guren/server` の `Controller`/`json`/`redirect` を Vitest 用に配線したドロップインモック。
- `readInertiaResponse(response)` — Inertia レスポンスを `{ format, payload, body }` に正規化し、アサーションを簡単に。

これらを Vitest スイート（例: `examples/blog/tests`）に取り込み、React/Inertia コントローラテストを表現的にしつつ Bun 固有 API を避けられます。

### トラブルシュート

- `vi.mock is not a function` が出る場合、そのテストは Bun で動いています。上記の Vitest コマンドに切り替えてください。
- `ReferenceError: document is not defined` は DOM 依存のテストが jsdom 外で走っているサインです。Vitest ランナーを使うか jsdom を明示的に設定してください。

ランナーを分けることで、フレームワークコードには Bun 由来の高速フィードバックを、SPA には実ブラウザに近い DOM 挙動を両立できます。
