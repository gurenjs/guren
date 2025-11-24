# チュートリアル: 認証を実装する

組み込みの認証スタックをスキャフォールドしてアプリを保護します。

1. **スキャフォールドを生成** — `bunx guren make:auth --force` を実行してコントローラ、ビュー、マイグレーション、`AuthProvider` を作成。
2. **プロバイダーを配線** — `src/app.ts` で `AuthProvider`、`createSessionMiddleware`、`attachAuthContext` をブート前に登録:
   ```ts
   app.register(DatabaseProvider)
   app.register(AuthProvider)
   app.use('*', createSessionMiddleware())
   app.use('*', attachAuthContext())
   ```
3. **マイグレーションとシードを実行** — `bun run db:migrate` の後に `bun run db:seed` を実行し、`users` テーブルとデモユーザーを作成。
4. **ルートを保護** — ダッシュボードや投稿管理に `requireAuthenticated` を適用:
   ```ts
   Route.group('/dashboard', () => {
     Route.get('/', [DashboardController, 'index'])
   }, requireAuthenticated({ redirectTo: '/login' }))
   ```
5. **動作確認** — `/register` でユーザー作成、またはシード済み資格情報で `/login` にログイン。コントローラ内では `const user = await this.auth.user()` のように `auth` ヘルパーでサインイン済みユーザーへアクセスします。
