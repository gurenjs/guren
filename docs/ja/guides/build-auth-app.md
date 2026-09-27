# 認証アプリを作る

このガイドでは、ユーザー登録とログイン、ログインしないと見られないルートを持つアプリを作ります。空のディレクトリから始めて、認証の流れができあがるまで 10 分もかかりません。

> [!NOTE]
> このガイドは作業の手順を追うためのものです。セッション、ガード、ユーザープロバイダーの詳しい説明は[認証ガイド](./authentication.md)にあります。

## 前提条件

- **Bun 1.4.2**
- **Docker Desktop (Compose v2)**: Postgres 用

## 1. プロジェクトを作成する

```bash
bunx create-guren-app my-auth-app --mode ssr --db postgres
cd my-auth-app
bun install
```

## 2. 認証機能を追加する

`add auth` ジェネレーターを実行すると、コントローラー、Inertia ページ、ユーザーモデル、マイグレーション、セッションミドルウェアがまとめて生成されます。

```bash
bunx guren add auth
```

生成されるのは次のものです。

- `app/Http/Controllers/Auth/LoginController.ts` と `RegisterController.ts`
- パスワードとリメンバートークンのカラムを持つ `app/Models/User.ts`
- `resources/js/pages/Auth/` 以下の Inertia ページ
- アプリケーションのプロバイダーに登録された `AuthProvider`
- 開発環境向けの既定値で設定されたセッションミドルウェア
- `routes/web.ts` の registrar から呼ばれる `routes/auth.ts`

## 3. データベースを起動する

```bash
bun run db:up
```

マイグレーションを実行して、`users` テーブルを作ります。

```bash
bunx guren db:migrate
```

## 4. 型マニフェストを生成する

```bash
bun run codegen
```

ルートとページの型付きマニフェストが生成されます。これで、コントローラーとフロントエンドのコンポーネントが型でつながります。

## 5. 開発サーバーを起動する

```bash
bun run dev
```

`http://localhost:3333/register` でアカウントを作り、`http://localhost:3333/login` からログインしてみてください。

## 6. 主要なコードを理解する

### LoginController

生成されたコントローラーは、入力を `LoginSchema` で検証してから、認証の処理をガードに任せます。`LoginSchema` は、同時に生成される `app/Http/Validators/LoginValidator.ts` にあります。

```typescript
import { Controller, ValidationException } from '@guren/core'
import { LoginSchema } from '../../Validators/LoginValidator.js'
import { pages } from '@/.guren/pages.gen'

export default class LoginController extends Controller {
  async show(): Promise<Response> {
    const email = this.request.query('email') ?? ''
    return this.inertia(pages.auth.Login, { email }, { title: 'Login' })
  }

  async store(): Promise<Response> {
    const { email, password, remember } = await this.validateBody(LoginSchema)

    this.auth.session()?.regenerate()

    const authenticated = await this.auth.attempt({ email, password }, remember)

    if (!authenticated) {
      throw ValidationException.withMessages({ message: 'Invalid credentials.' })
    }

    return this.redirect('/dashboard')
  }

  async destroy(): Promise<Response> {
    await this.auth.logout()
    this.auth.session()?.invalidate()
    return this.redirect('/')
  }
}
```

認証に失敗したときは `ValidationException.withMessages()` の例外を投げます。フレームワークはこれを `errors` 付きの 422 として返し、生成されたログインページが `errors.message` を表示します。メッセージを特定の入力欄に出したいときは、キーにフィールド名を使ってください（`{ email: '...' }`）。

### 認証ミドルウェア

ジェネレーターは `routes/auth.ts` を生成し、ルートの registrar から呼び出されるようにつなぎます。ガードはルートごとに指定します。

```typescript
import { Router, requireAuthenticated, requireGuest } from '@guren/core'

export function registerAuthRoutes(router: Router): void {
  router.get('/login', [LoginController, 'show'], requireGuest({ redirectTo: '/dashboard' })).name('login')
  router.post('/login', [LoginController, 'store'], requireGuest({ redirectTo: '/dashboard' })).name('login.store')
  router.post('/logout', [LoginController, 'destroy'], requireAuthenticated({ redirectTo: '/login' })).name('logout')

  router.get('/dashboard', [DashboardController, 'index'], requireAuthenticated({ redirectTo: '/login' })).name('dashboard')
}
```

グループ全体を短い名前で保護したいときは、エイリアスを自分で登録します。`aliasMiddleware()` はエイリアス名を型に含んだ Router を返すので、戻り値は必ず変数で受け取ってください。

```typescript
export function registerWebRoutes(baseRouter: Router): void {
  const router = baseRouter.aliasMiddleware('auth', requireAuthenticated({ redirectTo: '/login' }))

  router.middleware('auth').group((auth) => {
    auth.get('/dashboard', [DashboardController, 'index']).name('dashboard')
  })
}
```

### 保護されたページ

保護されたコントローラーの中では、`this.auth` からログイン中のユーザーを取り出せます。

```typescript
import { Controller } from '@guren/core'
import type { UserRecord } from '../../Models/User.js'
import { pages } from '@/.guren/pages.gen'

export default class DashboardController extends Controller {
  async index(): Promise<Response> {
    const currentUser = await this.auth.user<UserRecord | null>()
    const user = currentUser
      ? { id: currentUser.id, name: currentUser.name, email: currentUser.email }
      : null
    return this.inertia(pages.dashboard.Index, { user }, { title: 'Dashboard' })
  }
}
```

`this.auth.user<T>()` は、ゲストのときは `null` を返します。`null` を分岐で扱わずに 401 を返したいときは、`this.auth.userOrFail<T>()` を使ってください。

## 7. フローを検証する

1. `/register` を開いてユーザーを作る
2. `/login` を開き、作ったアカウントでログインする
3. `/dashboard` に移り、ユーザー名が表示されることを確かめる
4. シークレットウィンドウで `/dashboard` を開き、`/login` にリダイレクトされることを確かめる
5. ログアウトして、ログインページに戻ることを確かめる

## 次のステップ

- [メール認証](./email-verification.md): 保護されたルートに入る前に、メールアドレスの確認を求める
- [パスワードリセット](./password-reset.md): ユーザーが自分でアカウントを取り戻せるようにする
- [認可](./authorization.md): ロールに基づくアクセス制御を加える
- [API トークン](./api-tokens.md): プログラムからアクセスするためのトークンを発行する
