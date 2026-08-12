# デプロイガイド

`create-guren-app` で生成したアプリを本番に出す手順をまとめます。PostgreSQL が利用できる前提です。

## 本番チェックリスト
- 環境変数を設定（`DATABASE_URL`, `APP_URL`, `PORT` など）。
- Bun で依存パッケージを本番モードでインストール。
- フロントエンドアセットをビルド。
- マイグレーションを実行（必要ならシードも）。
- Bun サーバーをプロセスマネージャーやコンテナで起動。

## 1. 環境変数を用意
本番用 `.env` を作成するか、ホスティングの環境変数機能を使います。最低限、以下の変数が必要です。

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
デプロイ先で以下を実行します。

```bash
bun install --production
```

デプロイ中にアセットをビルドする環境では dev 依存も必要な場合があるため、必要に応じて `--production` を外してください。

## 3. フロントエンドアセットをビルド

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
直接 Bun で起動できます。

```bash
NODE_ENV=production bun run bin/serve.ts
```

信頼性のため、プロセスマネージャー（`systemd`, `pm2`, `supervisord` など）やホスティングの起動コマンドでラップしてください。以下は `systemd` ユニットの例です。

- スタートアップバナーは本番では既定で非表示です。表示したい/明示的に消したい場合は `GUREN_DEV_BANNER=1` または `GUREN_DEV_BANNER=0` を設定。
- `NODE_ENV=production` では Vite dev サーバーを起動しません。もし本番相当環境で起動したい/抑制したい場合は `GUREN_DEV_VITE=1`/`0` を切り替えてください。
- 本番以外では、ポートが使用中の場合に次のポートへ移動して起動します（`bun run dev` の利便性のため）。`GUREN_STRICT_PORT=1` を設定すると、要求したポートにバインドできなければ `EADDRINUSE` で失敗します。smoke スクリプト・E2E ランナー・CI など「起動したアプリ自身に接続できたこと」を保証したい場面では必ず設定してください。ポートを移動してしまうと、既に待ち受けていた別のサーバーに対してテストが通ってしまいます。
- HTTP サーバー自体の後始末はすでに配線済みです。`listen()` が `SIGINT`、`SIGTERM`、プロセス終了時にソケットを閉じます。これらはプロセスマネージャーやコンテナランタイムがサービス停止時に送るシグナルです。ただし、アプリが動かしているそれ以外のものには個別の停止処理が必要です。スケジューラー、キューワーカー、タイマーを保持するストアなどが該当し、[スケジューリング](./scheduling.md)、[キュー](./queue.md)、[レート制限](./rate-limiting.md) の各ガイドで説明しています。[`app.stop()`](./architecture.md#サーバーの停止) を呼ぶのは、プロセスの終了ではなくアプリケーションのコードがサーバーの停止時点を決める場合です。

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

ビルドと実行は以下のコマンドで行います。

```bash
docker build -t my-app .
docker run --env-file .env.prod -p 3333:3333 my-app
```

このイメージにはクライアント/SSR バンドルが同梱されるため、サーバーは初回から SSR HTML をストリームできます。環境に応じて設定ファイルやシークレットをマウントしてください。

## AWS Lambda（サーバーレス）

Guren は AWS Lambda の Node.js ランタイム上で動作します。トラフィックが変動するアプリやインフラ管理を最小化したい場合に最適です。公式プラグインがバンドルを担当し、インフラ用の CDK コンストラクトも同梱しています:

```bash
bunx guren plugin @guren/plugin-lambda
bun add @guren/plugin-lambda
```

CLI は `src/lambda.ts`（その export がそのまま Lambda ハンドラーになります）をスキャフォールドし、`lambda:build` コマンドを登録します:

```bash
bunx guren lambda:build
```

ビルドは `.lambda/` ディレクトリを生成します: 自己完結の関数バンドル、S3 用にステージングされた静的アセット、関数が必要とする環境変数の一覧です。HTTP、SQS キュー、EventBridge スケジューリング、CLI コマンドの専用ハンドラーを提供しています。データベース・SSR・CDK デプロイまで含めた詳細は **[サーバーレスデプロイガイド](./serverless.md)** を参照してください。

## Vercel（サーバーレス）

SSR アプリは公式プラグインで Vercel にデプロイできます。プラグインは Vercel の Bun ランタイム上で動作する [Build Output API](https://vercel.com/docs/build-output-api/v3) ディレクトリを生成します。

```bash
bunx guren plugin @guren/plugin-vercel
bun add @guren/plugin-vercel
```

CLI が `src/vercel.ts`、`scripts/vercel-build.ts`、`vercel.json` を自動生成します。ビルドとデプロイ:

```bash
bun run vercel:build
vercel deploy --prebuilt
```

> [!NOTE]
> このプラグインは SSR アプリ専用です。Vite マニフェストを読み取り、サーバーレス関数に正しい `GUREN_INERTIA_*` 環境変数を注入します。API-only アプリは Docker や Lambda を使ってください。

## Cloudflare Workers

公式プラグインを使うと、データベースに D1 を用いて Cloudflare Workers 上でアプリを動かせます。

```bash
bunx guren plugin @guren/plugin-cloudflare
bun add @guren/plugin-cloudflare
```

```bash
bunx guren cloudflare:build
bunx wrangler deploy
```

Workers にはファイルシステムがなく、リクエスト間でメモリを共有しません。そのためセッションと OAuth state はデータベースに保存する必要があり、マイグレーションはアプリの外側で適用します。D1・シークレット・無料プランの制限・ローカル開発を含む詳細は **[Cloudflare Workers へのデプロイ](./cloudflare.md)** を参照してください。

## デプロイ後の作業
- HTTPS を設定（Nginx/Caddy などのリバースプロキシやクラウド機能）。
- ログ・モニタリングを構成（Bun は stdout/stderr に出力するので、集約先へ転送）。
- PostgreSQL の自動バックアップをスケジュール。
- ヘルスチェックを実装し（例: `registerHealthRoutes(router)` で `router.get('/health', (ctx) => ctx.json({ ok: true }))` を公開）、ロードバランサーに組み込みます。

このチェックリストを守れば、毎回再現性のあるリリースができ、DB を安全にマイグレーションしつつ本番レスポンスを維持できます。
