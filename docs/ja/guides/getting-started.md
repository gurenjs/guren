# Getting Started

`create-guren-app` で新規プロジェクトを作成した後のフルセットアップ手順です。英語版と同等の内容をまとめています。

## 前提ツール
- **Bun 1.1 以降**  
  例: `curl -fsSL https://bun.sh/install | bash`
- **Docker Desktop (Compose v2)**  
  Postgres をコンテナで動かす場合に使用します。
- **Node.js（任意）**  
  ランタイムには不要ですが、エディタ補助や型定義に便利です。

### 1. プロジェクトを作成
```bash
bunx create-guren-app my-app
cd my-app
```
テンプレート作成時に SSR/SPA を選択できます。プロンプトをスキップする場合は `--mode ssr` または `--mode spa` を指定し、空でないディレクトリに生成する場合は `--force` を付けます。

### 2. 依存関係をインストール
```bash
bun install
```
Guren 本体、Inertia クライアント、React、TypeScript などが一括で入ります。

### 3. 環境変数を設定
```bash
cp .env.example .env
```
主に `APP_URL`（Inertia に渡すベース URL）、`DATABASE_URL`（Postgres 接続文字列）、`PORT`（HTTP ポート、既定は 3333）を環境に合わせてください。

> [!CAUTION]
> `.env` はリポジトリにコミットしないでください。もし漏洩させた場合はデータベースユーザーのローテーションや API キーの再発行を行ってください。

### 4. PostgreSQL を用意
PostgreSQL 15+ が必要です。手元でコンテナを立てる例:
```bash
docker run --name guren-postgres \
  -e POSTGRES_USER=guren \
  -e POSTGRES_PASSWORD=guren \
  -e POSTGRES_DB=guren \
  -p 54322:5432 \
  -d postgres:15
```
すでに動いているインスタンスがある場合は `DATABASE_URL` をその接続先に変えるだけで構いません。

### 5. 開発サーバーを起動
```bash
bun run dev
```
- `http://localhost:3333` を開いて確認します。
- Bun プロセスが Hono サーバーと Vite を同時に立ち上げます。`GUREN_DEV_VITE=0` で Vite の起動を抑制できます。
- Inertia のアセット解決は開発時に自動で Vite へ向きます（本番はビルド済み資産を参照）。

### 6. 次のステップ
- コード生成:  
  `bunx guren make:controller PostsController`  
  `bunx guren make:model Post`  
  `bunx guren make:view posts/Index`
- マイグレーション/シード:  
  `bun run db:migrate`  
  `bun run db:seed`
- さらに学ぶ: [アーキテクチャ](./architecture.md) → [ルーティング](./routing.md) → [コントローラ](./controllers.md) の順で読むとスムーズです。

## 本番ビルド
出荷準備ができたらビルドします:
```bash
NODE_ENV=production bun run build
```
クライアント/SSR ビルドが生成され、ハッシュ付きアセットとマニフェストが `public/assets/` に出力されます。実行中の Bun サーバーはこれを参照して SSR を返します。

## 追加リソース
1. [Architecture](./architecture.md)
2. [Routing](./routing.md)
3. [Controller](./controllers.md)
4. [Database](./database.md)
5. [Frontend](./frontend.md)
6. [Authentication](./authentication.md)
7. [Testing](./testing.md)
8. [Deployment](./deployment.md)

ツールの詳細は [CLI リファレンス](./cli.md) を参照してください。
