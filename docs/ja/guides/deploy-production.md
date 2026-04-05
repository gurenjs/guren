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
| `APP_ENV` | `production` | 本番最適化を有効化 |
| `PORT` | `3333` | サーバーのリッスンポート |
| `DATABASE_URL` | `postgres://user:pass@host:5432/db` | Postgres 接続文字列 |
| `SESSION_SECRET` | *(ランダムな64文字の文字列)* | セッション Cookie の署名 |

> [!WARNING]
> シークレットを git にコミットしないでください。プラットフォームのシークレットマネージャーを使うか、デプロイ時に環境変数を注入してください。

セッションシークレットは以下のコマンドで生成できます:

```bash
openssl rand -hex 32
```

## 2. Dockerfile を作成する

プロジェクトルートに `Dockerfile` を作成します:

```dockerfile
FROM oven/bun:1 AS base
WORKDIR /app

# 依存関係のインストール
FROM base AS deps
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

# アプリケーションのビルド
FROM base AS build
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .
RUN bun run build

# 本番イメージ
FROM base AS production
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/public ./public
COPY --from=build /app/package.json ./

ENV APP_ENV=production
ENV PORT=3333
EXPOSE 3333

CMD ["bun", "run", "start"]
```

ローカルでビルドしてテストします:

```bash
docker build -t my-app .
docker run -p 3333:3333 --env-file .env.production my-app
```

## 3. データベースマイグレーションを実行する

マイグレーションは Dockerfile 内ではなく、デプロイパイプラインの一部として実行します。これにより、コンテナ起動のたびにマイグレーションが走るのを防げます:

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

- **リバースプロキシ** — Nginx や Caddy を Bun の前に配置して TLS 終端と静的アセット配信を担当させる
- **プロセス監視** — Docker の `restart: unless-stopped` や systemd などのプロセスマネージャーを使用する
- **ロギング** — 構造化ログを設定し、集約サービスに転送する
- **バックアップ** — `pg_dump` やマネージドデータベースサービスで定期的な Postgres バックアップをスケジュールする

## 次のステップ

- [サーバーレスガイド](./serverless.md) — AWS Lambda にデプロイする
- [運用](./operations.md) — 監視、スケーリング、メンテナンス
- [ヘルスチェック](./health-checks.md) — ヘルスチェックの詳細設定
