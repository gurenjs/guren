# Getting Started

`create-guren-app` で新規プロジェクトを作成し、動かすまでの手順です。

> [!NOTE]
> 用語が分からない場合は先に [用語集](./glossary.md) を参照してください。

## 前提ツール
- **Bun 1.1 以降**
  例: `curl -fsSL https://bun.sh/install | bash`
- **Node.js（任意）**
  ランタイムには不要ですが、エディタ補助や型定義に便利です。

## Quick Start

次の手順で、認証付きブログアプリをゼロから構築できます。

```bash
# 1. プロジェクトを作成
bunx create-guren-app my-app --mode ssr
cd my-app
bun install

# 2. 認証とリソースを追加
bunx guren add auth
bunx guren add resource posts --fields "title:string,body:text"

# 3. 型付きルートヘルパー・ページ Props・API クライアントを生成
bun run codegen

# 4. データベースを準備
bun run db:migrate
bun run db:seed

# 5. 型チェックとビルドで整合性を確認
bun run typecheck
bun run build

# 6. 開発サーバーを起動
bun run dev
```

`http://localhost:3000` を開いてアプリを確認します。`/login` で `demo@example.com` / `secret` でサインインできます。

## 各ステップの補足

### プロジェクト作成

`--mode ssr` で SSR テンプレートを指定します。SPA を選ぶ場合は `--mode spa` を使います。空でないディレクトリに生成する場合は `--force` を付けてください。

デフォルトのテンプレートは SQLite を使用するため、追加のデータベースセットアップなしですぐに開発を始められます。

### 機能の追加

`bunx guren add auth` は認証に必要な Provider、Controller、Validator、ルート、ページを一括生成します。`bunx guren add resource posts --fields "title:string,body:text"` は `PostController`、`PostResource`、`PostValidator`、CRUD ページ、named routes を生成します。

### codegen

`bun run codegen` は次のファイルを生成します。

- `.guren/routes.gen.ts` -- named route helper の型情報
- `.guren/pages.gen.ts` -- Inertia page props の型情報
- `.guren/data.gen.ts` -- JsonResource の型情報
- `.guren/api-client.gen.ts` -- 型付き API クライアント

codegen は `bun run typecheck` や `bun run build` の前に実行してください。

### 環境変数

```bash
cp .env.example .env
```

主に `APP_URL`（Inertia に渡すベース URL）、`DATABASE_URL`（接続文字列）、`PORT`（HTTP ポート）を環境に合わせてください。

> [!CAUTION]
> `.env` はリポジトリにコミットしないでください。漏洩した場合はデータベースユーザーのローテーションや API キーの再発行を行ってください。

### 本番環境で PostgreSQL を使う

デフォルトの SQLite は開発には十分ですが、本番では PostgreSQL を推奨します。Docker で手軽に立てる例を示します。

```bash
docker run --name guren-postgres \
  -e POSTGRES_USER=guren \
  -e POSTGRES_PASSWORD=guren \
  -e POSTGRES_DB=guren \
  -p 54322:5432 \
  -d postgres:15
```

`.env` の `DATABASE_URL` を `postgres://guren:guren@localhost:54322/guren` に変更し、`bun run db:migrate` を再実行してください。

## さらに機能を追加する

アプリが動いたら、必要に応じてサブシステムを追加できます。

```bash
bunx guren add queue           # バックグラウンドジョブ (Memory/Redis)
bunx guren add mail            # メール送信 (SMTP/Resend)
bunx guren add events          # イベントディスパッチとリスナー
bunx guren add cache           # キャッシュ (Memory/Redis/File)
bunx guren add notifications   # マルチチャネル通知 (Mail/Database/Slack)
bunx guren add storage         # ファイルストレージ (Local/S3/Memory)
bunx guren add broadcasting    # リアルタイムブロードキャスト (SSE)
bunx guren add schedule        # cron ベースのタスクスケジューリング
```

機能を追加した後は `bun run codegen` を再実行して型を再生成してください。

## 本番ビルド

本番環境にデプロイする準備ができたらビルドします。

```bash
NODE_ENV=production bun run build
```

クライアント/SSR ビルドが生成され、ハッシュ付きアセットとマニフェストが `public/assets/` に出力されます。実行中の Bun サーバーはこれを参照して SSR を返します。

## 次のステップ

- [10分で最初の機能を作る](./first-steps.md) -- 実際にコードを書きながら流れを理解する
- [アーキテクチャ](./architecture.md) -- フレームワークの構造を把握する
- [ルーティング](./routing.md) -- ルート定義の詳細
- [コントローラー](./controllers.md) -- リクエスト処理のパターン
- [データベース](./database.md) -- ORM とマイグレーション
- [フロントエンド](./frontend.md) -- Inertia + React の統合
- [認証](./authentication.md) -- 認証の詳細設定
- [テスティング](./testing.md) -- テストの書き方
- [デプロイ](./deployment.md) -- 本番環境への配置

ツールの詳細は [CLI リファレンス](./cli.md) を参照してください。
