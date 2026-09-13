# 本番環境にデプロイする

このガイドでは、Guren アプリケーションをローカル開発環境から本番環境に移行するための手順を説明します。Bun を使った Docker ベースのデプロイを中心に解説します。

> [!NOTE]
> AWS Lambda へのサーバーレスデプロイについては[サーバーレスガイド](./serverless.md)を、デプロイの全体像については[デプロイ](./deployment.md)を参照してください。

## デプロイ前チェックリスト

デプロイの前に以下のコマンドを実行して、問題を早期に検出します:

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

エラーがあればすべて修正してから進めてください。`doctor` コマンドは、ルート、コントローラー、ページ間の不一致を検出し、実行時エラーを未然に防ぎます。

## 1. 環境変数を設定する

本番環境では最低限以下の変数が必要です:

| 変数 | 例 | 用途 |
|------|-----|------|
| `APP_URL` | `https://example.com` | 公開 URL |
| `PORT` | `3333` | サーバーのリッスンポート |
| `DATABASE_URL` | `postgres://user:pass@host:5432/db` | Postgres 接続文字列 |
| `APP_KEY` | `base64:...` | セッション、Cookie、トークンの暗号化と署名 |

`NODE_ENV=production` は次の手順で生成する Dockerfile が設定するので、表には含めていません。

> [!WARNING]
> シークレットを git にコミットしないでください。プラットフォームのシークレットマネージャーを使うか、デプロイ時に環境変数を注入してください。

本番用の `APP_KEY` は以下のコマンドで生成します:

```bash
bunx guren key:generate
```

サーバーは base64 エンコードされた 32 バイトの値以外をキーとして受け付けません。`openssl rand -hex` の出力は使えません。キーのローテーションは[暗号化](./encryption.md)を参照してください。

イメージをローカルで試すときは、これらの変数を `.env.production` に書いてください。次の節の `docker run` がこのファイルを読みます。イメージ自体には `.env` が含まれません。

## 2. Dockerfile を生成する

`Dockerfile` は CLI に書き出させます:

```bash
bunx guren deploy --target docker
```

書き出されるのは 2 段階のビルドです。ビルダー段階ですべての依存をインストールし、`bun run build` を実行します。本番段階では実行時の依存だけをインストールし、サーバーが実行時に読むものだけをコピーして、`NODE_ENV=production` で `bun bin/serve.ts` を起動します。コピーする対象の正確な一覧はファイルを開いて確認してください。

Guren アプリには `dist/` の出力も `start` スクリプトもありません。ほかの Bun プロジェクトの Dockerfile を流用しても起動しないのはこのためです。アプリが 3333 以外のポートで待ち受ける場合は `--port` を渡してください。`Dockerfile` がすでにあるとコマンドは止まります。Guren を更新したら `--force` を付けて再実行し、レシピの変更を取り込んでください。自分で加えた変更はその後で当て直します。

ローカルでビルドしてテストします:

```bash
docker build -t my-app .
docker run -p 3333:3333 --env-file .env.production my-app
```

## 3. データベースマイグレーションを実行する

マイグレーションは Dockerfile の中ではなく、デプロイパイプラインの一部として実行します。コンテナが起動するたびにマイグレーションが走るのを防ぐためです:

```bash
# CI/CD パイプラインまたはデプロイスクリプト内で
bunx guren db:migrate --force
```

`--force` フラグは本番環境での確認プロンプトを省略します。

## 4. ヘルスチェックを設定する

ロードバランサーやコンテナオーケストレーターがアプリの稼働を確認できるよう、ヘルスチェックエンドポイントをルートに追加します:

```typescript
import { Router } from '@guren/core'

export function registerWebRoutes(router: Router): void {
  router.get('/health', (c) => {
    return c.json({ status: 'ok' })
  })

  // ... 他のルート
}
```

データベース接続も含むより詳細なチェックについては、[ヘルスチェック](./health-checks.md)を参照してください。

## 5. 本番用 Docker Compose を構成する

シングルサーバーのデプロイでは、`docker-compose.production.yml` で管理すると便利です:

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

以下のコマンドでデプロイします:

```bash
docker compose -f docker-compose.production.yml up -d
```

## 6. デプロイ後の検証

デプロイ後、すべてが正常に動作しているか確認します:

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

アプリがデプロイされて稼働したら、以下の追加対策を検討してください:

- **リバースプロキシ**: Nginx や Caddy を Bun の前に置き、TLS 終端と静的アセット配信を任せる
- **HSTS**: `NODE_ENV=production` では `Strict-Transport-Security: max-age=31536000` が自動で送信されます。`createApp` の `securityHeaders: { hsts: { ... } }` で `includeSubDomains`/`preload` を追加でき、内部で平文 HTTP を配信する場合は `hsts: false` で無効化できます
- **プロセス監視**: Docker の `restart: unless-stopped` や systemd などのプロセスマネージャーを使う
- **ロギング**: 構造化ログを設定し、集約サービスに転送する
- **バックアップ**: `pg_dump` やマネージドデータベースサービスで、Postgres の定期バックアップをスケジュールする

## 次のステップ

- [サーバーレスガイド](./serverless.md): AWS Lambda にデプロイする
- [運用](./operations.md): 監視、スケーリング、メンテナンス
- [ヘルスチェック](./health-checks.md): ヘルスチェックの詳細設定
