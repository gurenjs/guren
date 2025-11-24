# Guren ドキュメント概要

Guren は Bun を前提にした TypeScript の MVC フルスタックフレームワークです。Hono、Inertia.js、React、Drizzle ORM を組み合わせ、Laravel ライクな開発体験を Bun の速度で提供します。

## なぜ Guren?
- **高速な内側ループ**: Bun と Hono がホットリロード付きの軽量サーバーを提供し、変更がすぐに反映されます。
- **Laravel に近い書き心地**: `Route` DSL や `Controller`/`Model` のベースクラス、Inertia を介したページ返却で直感的に作業できます。
- **型安全なデータアクセス**: Drizzle ORM が Eloquent 風の API とリッチな TypeScript 型を両立します。
- **オールインワンの初期化**: `create-guren-app` がバックエンド・フロントエンド・データベース設定までまとめて生成します。

## クイックスタート
1. プロジェクトを生成（プロンプトで SSR/SPA を選択、`--mode ssr|spa` で指定可能）: `bunx create-guren-app my-app`
2. ディレクトリへ移動: `cd my-app`
3. 依存関係をインストール: `bun install`
4. 開発サーバーを起動（Bun と Vite が同時に立ち上がります）: `bun run dev` を実行し `http://localhost:3333` を開きます。

PostgreSQL を使う場合は `.env` の `DATABASE_URL` を手元のインスタンスに合わせてください。コンテナでも既存のデータベースでも動作します。

## 次のステップ（英語）
- より詳しいセットアップ: [Getting Started](../guides/getting-started.md)
- 全体像の把握: [Architecture](../guides/architecture.md)
- 基本機能の学習: [Routing](../guides/routing.md) / [Controllers](../guides/controllers.md) / [Database](../guides/database.md)
- フロントエンド統合: [Frontend](../guides/frontend.md)
- 追加リファレンス: [CLI](../guides/cli.md), [Middleware](../guides/middleware.md)

まずは上記の順に読み進めると、Guren での開発の流れがスムーズに掴めます。
