# デプロイガイド

`create-guren-app` で生成したアプリを本番環境へ出すまでの手順をまとめます。PostgreSQL を使える環境があるものとします。

## 本番チェックリスト
- 環境変数（`DATABASE_URL`, `APP_URL`, `PORT` など）を設定する
- 依存パッケージを Bun の本番モードでインストールする
- フロントエンドのアセットをビルドする
- マイグレーションを実行する（必要ならシードも）
- プロセスマネージャーかコンテナの上で Bun サーバーを起動する

## 1. 環境変数を用意
本番用の `.env` を作るか、ホスティング側の環境変数の機能を使います。少なくとも次の変数が必要です。

```dotenv
APP_URL=https://example.com
PORT=3333
DATABASE_URL=postgres://user:password@db-host:5432/database
NODE_ENV=production
```

このファイルはコミットせず、プラットフォームのシークレット管理を使ってください。

> [!WARNING]
> `.env` の値はすべて機密として扱ってください。git の履歴やビルドログ、コンテナイメージに残らないよう、値はシークレットマネージャーから注入するのがおすすめです。

## 2. 依存をインストール
デプロイ先で次のコマンドを実行します。

```bash
bun install --production
```

デプロイの途中でアセットをビルドする環境では開発用の依存も要ることがあるので、その場合は `--production` を外してください。

## 3. フロントエンドアセットをビルド

```bash
NODE_ENV=production bun run build
```

雛形のビルドスクリプトは `bunx vite build` と `bunx vite build --ssr` を実行し、`public/assets/.vite/manifest.json` と `public/assets/.vite/ssr-manifest.json` を書き出します。実行時には `src/main.ts` の `autoConfigureInertiaAssets` がこの 2 つを読み、`GUREN_INERTIA_*` を自動で設定します。

## 4. マイグレーション（必要ならシード）

```bash
NODE_ENV=production bun run db:migrate
# オプション
bun run db:seed
```

デプロイのたびに実行して、スキーマを最新に保ちます。シードは任意で、主にデモやステージングのデータに使います。

> [!IMPORTANT]
> マイグレーションは、新しいコードがトラフィックを受け始める前に実行してください。途中まで適用されたマイグレーションのロールバックは面倒です。マイグレーションを実行した後にデプロイが失敗したら、マイグレーションは再実行せずに前のコミットを再デプロイしてください。

## 5. サーバー起動
Bun で直接起動できます。

```bash
NODE_ENV=production bun run bin/serve.ts
```

安定して動かすには、このコマンドをプロセスマネージャー（`systemd`, `pm2`, `supervisord` など）やホスティングの起動コマンドから呼び出してください。後ろに `systemd` ユニットの例を載せています。

- 起動時のバナーは、本番では既定で表示されません。代わりに、バインドしたアドレスを示す `[guren] Listening on http://<host>:<port>` の 1 行を出力します。バナーを表示するには `GUREN_DEV_BANNER=1`、明示的に消すには `GUREN_DEV_BANNER=0` を設定します。
- `NODE_ENV=production` のときは Vite の dev サーバーを起動しません。本番に近い環境で独自の開発フローを回すときは、`GUREN_DEV_VITE=1`（起動）と `GUREN_DEV_VITE=0`（起動しない）で切り替えてください。
- 本番以外では、ポートが使用中だと次のポートで起動します。`bun run dev` をそのまま使い続けられるようにするためです。`GUREN_STRICT_PORT=1` を設定すると、指定したポートにバインドできないときは `EADDRINUSE` で失敗するようになります。smoke スクリプトや E2E ランナー、CI のように、自分が起動したアプリに接続できたことを確かめたい場面では必ず設定してください。別のポートに移ってしまうと、もともと待ち受けていた別のサーバーを相手にテストが通ってしまいます。
- HTTP サーバー自体の後始末は最初から組み込まれています。`listen()` は `SIGINT` と `SIGTERM` を受けたときとプロセスの終了時にソケットを閉じます。プロセスマネージャーやコンテナランタイムがサービスを止めるときに送るのも、このシグナルです。一方、スケジューラーやキューワーカー、タイマーを持つストアなど、アプリが動かしているほかのものには、それぞれ停止処理が要ります。書き方は[スケジューリング](./scheduling.md)、[キュー](./queue.md)、[レート制限](./rate-limiting.md) の各ガイドにあります。プロセスの終了ではなくアプリケーションのコードがサーバーを止める時点を決める場合は、[`app.stop()`](./architecture.md#サーバーの停止) を呼んでください。

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

systemd を再読み込みしてから、`sudo systemctl enable --now my-app` でサービスを有効にして起動します。

## コンテナでのデプロイ例

Dockerfile は CLI で生成できます。

```bash
bunx guren deploy --target docker
```

生成されるのは 2 段階のビルドです。ビルダー段階では、`bun run build` が使う Vite や TypeScript も含めてすべての依存をインストールし、ビルドします。本番段階では実行時の依存だけをインストールし、サーバーが実行時に読むファイルをコピーしたうえで、`NODE_ENV=production` で `bun bin/serve.ts` を起動します。環境変数と、アップグレード後にこのファイルを生成し直す手順は[本番環境にデプロイする](./deploy-production.md)にあります。

ビルドと実行は次のとおりです。

```bash
docker build -t my-app .
docker run --env-file .env.prod -p 3333:3333 my-app
```

イメージにはクライアント用と SSR 用の両方のバンドルが入っているので、サーバーは最初のリクエストから SSR 済みの HTML をストリームで返せます。設定ファイルやシークレットは、ホスティング環境に合わせてマウントしてください。

## AWS Lambda（サーバーレス）

Guren は AWS Lambda の Node.js ランタイムでも動きます。トラフィックの増減が大きいアプリや、インフラの管理をなるべく減らしたい場合に向いています。バンドルは公式プラグインが受け持ち、インフラ用の CDK コンストラクトもプラグインに入っています。

```bash
bunx guren plugin @guren/plugin-lambda
bun add @guren/plugin-lambda
```

CLI は `src/lambda.ts` を生成し、`lambda:build` コマンドを登録します。`src/lambda.ts` の export がそのまま Lambda のハンドラーになります。

```bash
bunx guren lambda:build
```

ビルドすると `.lambda/` ディレクトリができます。中身は、単体で動く関数のバンドル、S3 に置くために用意した静的アセット、関数が必要とする環境変数の一覧です。CloudFront はこの静的ファイルを関数より手前で配信します。そのため CDK コンストラクトはアセット用のビヘイビアに viewer-response の関数を置き、ブラウザがドキュメントとして描画する形式 (`.html`、`.htm`、`.svg`、`.xhtml`、`.xml`) に `Content-Disposition: attachment` と `X-Content-Type-Options: nosniff` を付けます。フレームワークが自分で `public/` を配信するときと同じ扱いです。HTTP、SQS キュー、EventBridge のスケジュール実行、CLI コマンドには、それぞれ専用のハンドラーがあります。データベースや SSR、CDK でのデプロイまで含めた手順は **[サーバーレスデプロイガイド](./serverless.md)** を参照してください。

## Vercel（サーバーレス）

SSR アプリは、公式プラグインを使って Vercel にデプロイできます。プラグインは、Vercel の Bun ランタイムで動く [Build Output API](https://vercel.com/docs/build-output-api/v3) 形式のディレクトリを組み立てます。

```bash
bunx guren plugin @guren/plugin-vercel
bun add @guren/plugin-vercel
```

`src/vercel.ts`、`scripts/vercel-build.ts`、`vercel.json` は CLI が生成します。ビルドとデプロイは次のとおりです。

```bash
bun run vercel:build
vercel deploy --prebuilt
```

`vercel:build` は出力を書き出す前に、`guren doctor` と同じデプロイ先ランタイムのチェックを実行します。インメモリのセッションストアや OAuth ストア、[Bun でしか読めないパスワードハッシャー](/docs/guides/authentication#パスワードハッシャー)、ファイルシステムを走査するプロバイダ探索が見つかると警告を出します(ビルドは止めません)。どれもローカルでは動きますが、関数の呼び出しをまたぐと壊れます。

> [!NOTE]
> このプラグインは SSR アプリ専用です。Vite のマニフェストを読み、正しい `GUREN_INERTIA_*` 環境変数をサーバーレス関数に注入します。API-only アプリには Docker か Lambda を使ってください。

`public/` は `.vercel/output/static` にコピーされ、関数より手前で CDN が配信します。そのため生成される `config.json` には、ブラウザがドキュメントとして描画する形式 (`.html`、`.htm`、`.svg`、`.xhtml`、`.xml`) に `Content-Disposition: attachment` と `X-Content-Type-Options: nosniff` を付けるルートが入ります。フレームワークが自分で `public/` を配信するときと同じ扱いです。このルートは `handle: "hit"` の後ろにあるので、CDN が応答したファイルにだけ効きます。動的な `/sitemap.xml` のように関数が返すパスには影響しません。

## Cloudflare Workers

公式プラグインを使うと、D1 をデータベースにして Cloudflare Workers 上でアプリを動かせます。

```bash
bunx guren plugin @guren/plugin-cloudflare
bun add @guren/plugin-cloudflare
```

```bash
bunx guren cloudflare:build
bunx wrangler deploy
```

Workers にはファイルシステムがなく、リクエストの間でメモリも共有されません。そのため、セッションと OAuth の state はデータベースに保存する必要があり、マイグレーションはアプリとは別の手順で適用します。D1、シークレット、無料プランの制限、ローカル開発まで含めた手順は **[Cloudflare Workers へのデプロイ](./cloudflare.md)** を参照してください。

## デプロイ後の作業
- HTTPS を設定する（Nginx や Caddy などのリバースプロキシ、またはクラウドの機能を使う）
- ログとモニタリングを整える（Bun は stdout と stderr に出力するので、集約先へ送る）
- PostgreSQL の自動バックアップを定期実行にする
- ヘルスチェックを用意し（例: `registerHealthRoutes(router)` で `router.get('/health', (ctx) => ctx.json({ ok: true }))` を公開する）、ロードバランサーに登録する

このチェックリストに沿えば、リリースを毎回同じ手順で再現でき、データベースも安全にマイグレーションしながら、本番のアプリを応答できる状態に保てます。
