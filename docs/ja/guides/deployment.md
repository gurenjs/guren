# デプロイガイド

`create-guren-app` で生成したアプリを本番に出す手順をまとめます。PostgreSQL が利用できる前提です。

## 本番チェックリスト
- 環境変数を設定（`DATABASE_URL`, `APP_URL`, `PORT` など）。
- Bun で依存を本番モードでインストール。
- フロントエンド資産をビルド。
- マイグレーションを実行（必要ならシードも）。
- Bun サーバーをプロセスマネージャーやコンテナで起動。

## 1. 環境変数を用意
本番用 `.env` を作成するか、ホスティングの環境変数機能を使います。最低限:

```dotenv
APP_URL=https://example.com
PORT=3333
DATABASE_URL=postgres://user:password@db-host:5432/database
NODE_ENV=production
```

このファイルはコミットしないでください。プラットフォームのシークレット管理を使いましょう。

> [!WARNING]
> `.env` の値はすべて機密扱いにしてください。git 履歴やビルドログ、コンテナイメージに残らないよう、シークレットマネージャー経由で注入することを推奨します。

## 2. 依存をインストール
デプロイ先で:

```bash
bun install --production
```

デプロイ中にアセットをビルドする環境では dev 依存も必要な場合があるため、必要に応じて `--production` を外してください。

## 3. フロントエンド資産をビルド

```bash
NODE_ENV=production bun run build
```

スキャフォールド済みスクリプトは `bunx vite build` と `bunx vite build --ssr` を実行し、`public/assets/.vite/manifest.json` と `public/assets/.vite/ssr-manifest.json` を生成します。実行時に `src/main.ts` の `autoConfigureInertiaAssets` がこれらを読み取り、`GUREN_INERTIA_*` を自動設定します。

## 4. マイグレーション（必要ならシード）

```bash
NODE_ENV=production bun run db:migrate
# オプション
bun run db:seed
```

各デプロイでスキーマを同期させます。シードはデモやステージングで主に使用します。

> [!IMPORTANT]
> 新コードがトラフィックを処理する前にマイグレーションを実行してください。途中まで適用された状態からのロールバックは厄介です。デプロイ失敗時はマイグレーションを再実行せず、前のコミットを再デプロイしてください。

## 5. サーバー起動
直接 Bun で起動できます:

```bash
NODE_ENV=production bun run bin/serve.ts
```

信頼性のため、プロセスマネージャー（`systemd`, `pm2`, `supervisord` など）やホスティングの起動コマンドでラップしてください。例として `systemd` ユニット:

- スタートアップバナーは本番では既定で非表示です。表示したい/明示的に消したい場合は `GUREN_DEV_BANNER=1` または `GUREN_DEV_BANNER=0` を設定。
- `NODE_ENV=production` では Vite dev サーバーを起動しません。もし本番相当環境で起動したい/抑制したい場合は `GUREN_DEV_VITE=1`/`0` を切り替えてください。

```ini
[Unit]
Description=Guren Application
After=network.target

[Service]
EnvironmentFile=/etc/guren/my-app.env
WorkingDirectory=/var/www/my-app
ExecStart=/usr/local/bin/bun run bin/serve.ts
Restart=always

[Install]
WantedBy=multi-user.target
```

systemd をリロードし、`sudo systemctl enable --now my-app` で起動します。

## コンテナでのデプロイ例

```dockerfile
FROM oven/bun:1 AS base
WORKDIR /app

COPY bun.lock package.json ./
RUN bun install --production

COPY . .
RUN NODE_ENV=production bun run build

EXPOSE 3333
ENV NODE_ENV=production
CMD ["bun", "run", "bin/serve.ts"]
```

ビルドと実行:

```bash
docker build -t my-app .
docker run --env-file .env.prod -p 3333:3333 my-app
```

このイメージにはクライアント/SSR バンドルが同梱されるため、サーバーは初回から SSR HTML をストリームできます。環境に応じて設定ファイルやシークレットをマウントしてください。

## デプロイ後の作業
- HTTPS を設定（Nginx/Caddy などのリバースプロキシやクラウド機能）。
- ログ・モニタリングを構成（Bun は stdout/stderr に出力するので、集約先へ転送）。
- PostgreSQL の自動バックアップをスケジュール。
- ヘルスチェックを実装し（例: `Route.get('/health', (ctx) => ctx.json({ ok: true }))`）、ロードバランサーに組み込みます。

このチェックリストを守れば、毎回再現性のあるリリースができ、DB を安全にマイグレーションしつつ本番レスポンスを維持できます。
