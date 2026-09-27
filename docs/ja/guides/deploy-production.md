# 本番環境にデプロイする

このガイドでは、ローカルで開発してきた Guren アプリケーションを本番環境に載せるまでの手順を、Bun を使った Docker ベースのデプロイを例に説明します。

> [!NOTE]
> AWS Lambda へのサーバーレスデプロイは[サーバーレスガイド](./serverless.md)で、デプロイの全体像は[デプロイ](./deployment.md)で扱っています。

## デプロイ前チェックリスト

デプロイする前に次のコマンドを実行し、問題を早めに見つけておきます。

```bash
# フロントエンドとバックエンドをビルド
bun run build

# プロジェクト全体の型チェック
bun run typecheck

# テストスイートを実行
bun run test

# ルート・コントローラー・ページの整合性を検証
bunx guren doctor
```

エラーが出たら、すべて直してから先に進んでください。`doctor` コマンドはルート、コントローラー、ページの食い違いを見つけてくれるので、実行時エラーを事前に防げます。

## 1. 環境変数を設定する

本番環境では、少なくとも次の変数が必要です。

| 変数 | 例 | 用途 |
|------|-----|------|
| `APP_URL` | `https://example.com` | 公開 URL |
| `PORT` | `3333` | サーバーが待ち受けるポート |
| `DATABASE_URL` | `postgres://user:pass@host:5432/db` | Postgres の接続文字列 |
| `APP_KEY` | `base64:...` | セッション、Cookie、トークンの暗号化と署名に使う鍵 |

`NODE_ENV=production` は次の手順で生成する Dockerfile の中で設定されるため、表には入れていません。

> [!WARNING]
> シークレットは git にコミットしないでください。プラットフォームのシークレットマネージャーを使うか、デプロイ時に環境変数として渡してください。

本番用の `APP_KEY` は次のコマンドで生成します。

```bash
bunx guren key:generate
```

サーバーがキーとして受け付けるのは、base64 でエンコードした 32 バイトの値だけです。`openssl rand -hex` の出力は使えません。キーのローテーションについては[暗号化](./encryption.md)を参照してください。

イメージをローカルで試すときは、これらの変数を `.env.production` に書いておきます。次の節の `docker run` はこのファイルを読み込みます。イメージ自体には `.env` は入りません。

## 2. Dockerfile を生成する

`Dockerfile` は CLI で書き出します。

```bash
bunx guren deploy --target docker
```

書き出される Dockerfile は 2 段階のビルドになっています。ビルダー段階ではすべての依存をインストールして `bun run build` を実行し、本番段階では実行時の依存だけをインストールします。そのうえでサーバーが実行時に読むものだけをコピーし、`NODE_ENV=production` で `bun bin/serve.ts` を起動します。何をコピーしているかの正確な一覧は、生成されたファイルを開いて確認してください。

Guren アプリには `dist/` の出力も `start` スクリプトもないので、ほかの Bun プロジェクトの Dockerfile を流用しても起動しません。アプリが 3333 以外のポートで待ち受ける場合は `--port` を渡してください。`Dockerfile` がすでにあるときは、コマンドはそこで止まります。Guren を更新したら `--force` を付けて再実行してレシピの変更を取り込み、自分で加えていた変更はそのあとで当て直してください。

ローカルでビルドして動かしてみます。

```bash
docker build -t my-app .
docker run -p 3333:3333 --env-file .env.production my-app
```

## 3. データベースマイグレーションを実行する

雛形から作ったアプリは、データベースに初めて接続したときに未適用のマイグレーションを適用します。そのため、パイプラインで実行しなくてもコンテナは起動時にマイグレーションを済ませます。それでも、新しいイメージを展開する前にパイプラインで実行しておくほうが安全です。マイグレーションが失敗した時点でデプロイを止められますし、起動するコンテナには適用するものが残っていません。

```bash
# CI/CD パイプラインまたはデプロイスクリプト内で
bunx guren db:migrate
```

ただし例外が 2 つあります。Data API のアダプタは、`migrateOnStart` を指定したときにだけ起動時にマイグレーションします。D1 のマイグレーションは `wrangler d1 migrations apply` で適用するため、起動時には実行されません。詳しくは[マイグレーションが走るタイミング](./database.md#マイグレーションが走るタイミング)を参照してください。

## 4. ヘルスチェックを設定する

ロードバランサーやコンテナオーケストレーターがアプリの稼働を確かめられるように、ヘルスチェック用のエンドポイントをルートに追加します。

```typescript
import { Router } from '@guren/core'

export function registerWebRoutes(router: Router): void {
  router.get('/health', (c) => {
    return c.json({ status: 'ok' })
  })

  // ... 他のルート
}
```

データベース接続まで確かめる詳しいチェックは、[ヘルスチェック](./health-checks.md)を参照してください。

## 5. 本番用 Docker Compose を構成する

サーバー 1 台で運用するなら、`docker-compose.production.yml` にまとめておくと管理が楽になります。

```yaml
services:
  app:
    build: .
    ports:
      - "3333:3333"
    env_file: .env.production
    restart: unless-stopped
    depends_on:
      postgres:
        condition: service_healthy
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:3333/health"]
      interval: 30s
      timeout: 5s
      retries: 3

  postgres:
    image: postgres:17
    volumes:
      - pgdata:/var/lib/postgresql/data
    environment:
      POSTGRES_USER: ${DB_USER}
      POSTGRES_PASSWORD: ${DB_PASSWORD}
      POSTGRES_DB: ${DB_NAME}
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U ${DB_USER}"]
      interval: 10s
      timeout: 5s
      retries: 5

volumes:
  pgdata:
```

次のコマンドでデプロイします。

```bash
docker compose -f docker-compose.production.yml up -d
```

## 6. デプロイ後の検証

デプロイが終わったら、すべて正常に動いているかを確かめます。

```bash
# ヘルスチェックエンドポイントを確認
curl https://example.com/health
# 期待値: {"status":"ok"}

# ページの読み込みを確認
curl -I https://example.com
# 期待値: HTTP/2 200

# エラーログを確認
docker compose -f docker-compose.production.yml logs app --tail 50
```

## 本番環境の強化

アプリが稼働し始めたら、次の対策も検討してください。

- **リバースプロキシ**: Bun の前に Nginx や Caddy を置き、TLS の終端と静的アセットの配信を任せる
- **HSTS**: `NODE_ENV=production` では `Strict-Transport-Security: max-age=31536000` が自動で送られます。`includeSubDomains` や `preload` を付けたいときは `createApp` の `securityHeaders: { hsts: { ... } }` で指定し、内部で平文の HTTP を配信する場合は `hsts: false` で無効にします
- **プロセス監視**: Docker の `restart: unless-stopped` や systemd などのプロセスマネージャーを使う
- **ロギング**: 構造化ログを出し、集約サービスに転送する
- **バックアップ**: `pg_dump` やマネージドデータベースのサービスで、Postgres の定期バックアップを組む

## 次のステップ

- [サーバーレスガイド](./serverless.md): AWS Lambda にデプロイする
- [運用](./operations.md): 監視、スケーリング、メンテナンス
- [ヘルスチェック](./health-checks.md): ヘルスチェックの詳細設定
