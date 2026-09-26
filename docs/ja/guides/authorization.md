# 認可

認可は、認証済みのユーザーにどの操作を許すかを決める仕組みです。Guren の認可は、Laravel を参考にしたポリシーベースの設計になっています。

認可ゲートはアプリの起動時に自動で作られ、コンテナに `gate` として束縛されます。サービスプロバイダからは `this.container.make('gate')` で取り出して、ability を定義したりポリシーを登録したりします。手動でセットアップする必要はありません。

## ゲート

ゲートは、ユーザーが特定のアクションを実行してよいかを判定する小さなクロージャです。

### ゲートの定義

ゲートはサービスプロバイダの `boot()` で定義します。ゲート自体はフレームワーク側のプロバイダが登録処理の中で作るので、それより前に `make('gate')` を呼ぶと例外になります。

```typescript
import { ServiceProvider } from '@guren/core'

export default class AuthorizationProvider extends ServiceProvider {
  boot(): void {
    const gate = this.container.make('gate')

    // シンプルなゲート
    gate.define('view-dashboard', (user) => {
      return user?.isAdmin === true
    })

    // リソースを伴うゲート
    gate.define('update-post', (user, post) => {
      return user?.id === post.userId
    })

    // データベースチェックを伴う非同期ゲート
    gate.define('delete-comment', async (user, comment) => {
      const post = await Post.find(comment.postId)
      return user?.id === post?.userId
    })
  }
}
```

作ったプロバイダは `createApp({ providers })` に登録してください。

### ゲートの使用

コントローラでは `this.authorize()` と `this.can()` が使えます。どちらも現在のユーザーの束縛まで済ませてくれます。

```typescript
// 拒否時は AuthorizationException (403) をスロー
await this.authorize('update-post', post)

// 例外を投げずにチェック
const canView = await this.can('view-dashboard')
```

コントローラ以外では、呼び出し元が持っているコンテナからゲートを取り出します。ジョブやコマンドなら `this.make('gate')`、プロバイダなら `this.container.make('gate')`、ミドルウェアなら `getRequestContainer(ctx).make('gate')` です。取り出したら、`forUser()` でユーザーを束縛します。

```typescript
const gate = this.make('gate').forUser(user)

// 許可されているか
const canView = await gate.allows('view-dashboard')

// 拒否されているか
const cannotView = await gate.denies('view-dashboard')

// リソースを伴うチェック
const canUpdate = await gate.allows('update-post', post)

// 認可するか例外を投げる
await gate.authorize('update-post', post)
// 拒否時は AuthorizationException (403) をスロー
```

### Beforeコールバック

すべてのゲートチェックの前に実行するコールバックは、同じ `boot()` の中で登録します。

```typescript
gate.before((user, ability) => {
  // スーパー管理者はすべての操作が可能
  if (user?.isSuperAdmin) {
    return true
  }
  // undefined を返すとゲートのチェックに進む
})
```

### Afterコールバック

すべてのゲートチェックの後に実行するコールバックも登録できます。

```typescript
gate.after((user, ability, result) => {
  // 認可の試行をログに記録
  logger.info(`User ${user?.id} ${result ? 'allowed' : 'denied'} for ${ability}`)
})
```

## ポリシー

ポリシーを使うと、認可のロジックを特定のモデルやリソースごとにまとめられます。

### ポリシーの作成

ポリシーの雛形は CLI で生成できます。

```bash
bunx guren make:policy Post
```

手で書く場合は次のようになります。

```typescript
import { Policy, type AuthUser } from '@guren/core'
import type { PostRecord } from '../Models/Post'

export class PostPolicy extends Policy {
  /**
   * すべての投稿を閲覧できるか
   */
  viewAny(user: AuthUser | null): boolean {
    return true
  }

  /**
   * この投稿を閲覧できるか
   */
  view(user: AuthUser | null, post: PostRecord): boolean {
    return post.published || user?.id === post.userId
  }

  /**
   * 投稿を作成できるか
   */
  create(user: AuthUser | null): boolean {
    return user !== null
  }

  /**
   * この投稿を更新できるか
   */
  update(user: AuthUser | null, post: PostRecord): boolean {
    return user?.id === post.userId
  }

  /**
   * この投稿を削除できるか
   */
  delete(user: AuthUser | null, post: PostRecord): boolean {
    return user?.id === post.userId
  }
}
```

### ポリシーの登録

ポリシーも同じ `boot()` の中で、ゲートに登録します。

```typescript
// モデルクラスで登録
gate.policy(Post, PostPolicy)

// 文字列キーでも登録可能
gate.policy('post', PostPolicy)
```

### ポリシーの使用

ORM のクエリが返すのは、コンストラクタの情報を持たないプレーンなオブジェクトです。そのため、ポリシーを解決させるには、レコードと一緒にモデルクラスも渡します。

```typescript
const gate = this.make('gate').forUser(user)
const post = await Post.findOrFail(id)

// ORM レコードには [モデルクラス, レコード] を渡す
const canUpdate = await gate.allows('update', [Post, post])

// レコードを伴わないアビリティはクラス単体を渡す
const canCreate = await gate.allows('create', Post)

// 文字列キーも同様に使える
const canDelete = await gate.allows('delete', ['post', post])

// 認可するか例外を投げる(AuthorizationException, 403)
await gate.authorize('update', [Post, post])
```

クラスのインスタンス(`new` で作ったオブジェクト)であれば、タプルにしなくてもポリシーが自動で解決されます。

```typescript
const canView = await gate.allows('view', somePostInstance)
```

プレーンなレコードをタプルにせずに渡すと、ポリシーは見つかりません。その ability のゲートも定義されていなければ、チェックは拒否を返さずに `Error` を投げます。エラーメッセージには ability 名と、`[Model, record]` に直すよう促す内容が入ります。レコードの持ち主本人が理由のわからない 403 を受け取るのではなく、誤りが 500 として表に出るようにするためです。`before()` コールバックと、その ability に定義したゲートには、プレーンなレコードがそのまま渡ります。ポリシーのないクラスのインスタンスや、ポリシーのないモデルのタプルを渡した場合は拒否になります。

`gate.any()` と、配列を渡した `authorizeMiddleware()` は、ability を先頭から順に確認します。プレーンなレコードを渡すと、何も解決できなかった最初の ability で例外になり、後ろの ability が許可する場合でもそこで止まります。こちらでもタプルを渡してください。`authorizeMiddleware()` や `authorizeResourceMiddleware()` に渡す `modelResolver` も、レコードではなく `[Model, record]` を返すようにします。

### ポリシーメソッド

ポリシーで使える標準のメソッドは次のとおりです。

| メソッド | 説明 |
|---------|------|
| `viewAny` | すべてのリソースを閲覧できるか |
| `view` | 特定のリソースを閲覧できるか |
| `create` | 新しいリソースを作成できるか |
| `update` | リソースを更新できるか |
| `delete` | リソースを削除できるか |
| `restore` | ソフトデリートされたリソースを復元できるか |
| `forceDelete` | リソースを完全に削除できるか |

### Beforeメソッド

`before` メソッドを定義すると、そのポリシーのすべてのチェックより先に判定を差し込めます。

```typescript
export class PostPolicy extends Policy {
  before(user: AuthUser | null, ability: string): boolean | undefined {
    // 管理者は投稿に対してあらゆる操作が可能
    if (user !== null && (user as { isAdmin?: boolean }).isAdmin) {
      return true
    }
    // undefined を返すと個別メソッドのチェックに進む
  }
}
```

## コントローラー統合

コントローラーには `authorize()` と `can()` のヘルパーが組み込まれています。現在のユーザーは認証コンテキストから自動で解決され、ゲストの場合は `null` になります。

```typescript
import { Controller } from '@guren/core'
import { pages } from '@/.guren/pages.gen'
import { Post } from '@/app/Models/Post'
import { PostResource } from '@/app/Http/Resources/PostResource'

export default class PostController extends Controller {
  async show() {
    const { id } = this.validateParams(PostIdParamSchema)
    const post = await Post.findOrFail(id)

    // 拒否時は AuthorizationException (403) をスロー
    await this.authorize('view', [Post, post])

    return this.inertia(pages.posts.Show, { post: new PostResource(post).toJSON() })
  }

  async update() {
    const { id } = this.validateParams(PostIdParamSchema)
    const post = await Post.findOrFail(id)

    // 例外を投げずにチェック
    if (!(await this.can('update', [Post, post]))) {
      return this.json({ error: 'Unauthorized' }, 403)
    }

    // 更新処理...
  }
}
```

> **Tip:** `bunx guren make:feature Post --policy` を実行すると、ポリシーの生成に加えて、`store`/`update`/`destroy` への `authorize()` の呼び出しまで自動で組み込まれます。

## ミドルウェア

ルート単位でチェックしたい場合は、認可用のミドルウェアを作ります。

```typescript
import { type Router, getRequestContainer, AuthorizationException, defineMiddleware } from '@guren/core'

export function authorizeAbility(ability: string) {
  return defineMiddleware(async (ctx, next) => {
    const gate = getRequestContainer(ctx).make('gate')
    const user = await gate.resolveUser(ctx)

    if (await gate.forUser(user).denies(ability)) {
      throw new AuthorizationException()
    }

    await next()
  })
}

// ルートでの使用
export function registerWebRoutes(router: Router): void {
  router.get('/admin', [AdminController, 'index'], authorizeAbility('access-admin'))
}
```

`gate.resolveUser(ctx)` は、リクエストの認証コンテキストからログイン中のユーザーを取り出します。`createGate()` に `userResolver` を渡している場合は、そちらが優先されます。組み込みの `authorizeMiddleware('access-admin')` も、同じ方法でユーザーを解決します。

## ベストプラクティス

1. **モデル固有のロジックにはポリシーを使う。** 認可をモデルごとに整理できます。
2. **ゲートは小さく保つ。** ゲートは、特定のモデルに結び付かない ability に使います。
3. **重いチェックはキャッシュする。** 認可にデータベースのクエリが必要なら、キャッシュを検討してください。
4. **before コールバックは控えめに使う。** 多用するとデバッグが難しくなります。
5. **認可をテストする。** ゲートとポリシーのテストを書いてください。

## 認可のテスト

グローバルなインスタンスに頼らず、テストごとに新しい `Gate` を作ります。

```typescript
import { describe, it, expect, beforeEach } from 'bun:test'
import { Gate } from '@guren/core'
import { PostPolicy } from '../app/Policies/PostPolicy'

describe('PostPolicy', () => {
  let gate: Gate

  beforeEach(() => {
    gate = new Gate()
    gate.policy('post', PostPolicy)
  })

  it('allows owner to update post', async () => {
    const user = { id: 1 }
    const post = { id: 1, userId: 1 }

    expect(await gate.forUser(user).allows('update', ['post', post])).toBe(true)
  })

  it('denies non-owner from updating post', async () => {
    const user = { id: 2 }
    const post = { id: 1, userId: 1 }

    expect(await gate.forUser(user).denies('update', ['post', post])).toBe(true)
  })
})
```
