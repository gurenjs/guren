# チュートリアル: 認証を実装する

組み込みの認証スタックをスキャフォールドしてアプリを保護します。

1. **スキャフォールドを生成** — `bunx guren make:auth --install` を実行するとコントローラー、ビュー、マイグレーション、`AuthProvider` を作成し、セッションやルートも自動配線します。既存ファイルを上書きしたい場合は `--force` を併用。
2. **配線（通常は自動）** — `--install` で `AuthProvider` 登録とセッションミドルウェア、ルート接続まで自動化されます。セッション設定を調整したい場合は `createApp()` に auth オプションを渡してください:
   ```ts
   import { createApp } from '@guren/core'

   const app = createApp({
     auth: {
       autoSession: true, // 無効化したい場合は false
       sessionOptions: {
         cookieSecure: process.env.NODE_ENV === 'production',
       },
     },
   })
   ```
3. **マイグレーションとシードを実行** — `bun run db:migrate` の後に `bun run db:seed` を実行し、`users` テーブルとデモユーザーを作成。
4. **ルートを保護** — ダッシュボードや投稿管理に `requireAuthenticated` を適用:
   ```ts
   import { Router, requireAuthenticated } from '@guren/core'

   export function registerWebRoutes(router: Router): void {
     router.get('/dashboard', [DashboardController, 'index'], requireAuthenticated({ redirectTo: '/login' }))
   }
   ```
5. **動作確認** — `/register` でユーザー作成、またはシード済み資格情報で `/login` にログイン。コントローラー内では `const user = await this.auth.user()` のように `auth` ヘルパーでサインイン済みユーザーへアクセスします。
