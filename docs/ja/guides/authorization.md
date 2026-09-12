# 認可

認可は、認証済みユーザーが実行できる操作を制御する仕組みです。Guren の認可は、Laravel に着想を得たポリシーベースの設計になっています。

認可ゲートはアプリの起動時に自動で作られ、コンテナに `gate` として束縛されます。サービスプロバイダからは `this.container.make('gate')` で取得し、アビリティの定義やポリシーの登録を行います。手動のセットアップは要りません。

## ゲート

ゲートは、そのユーザーが特定のアクションを実行してよいかを判断する小さなクロージャです。

### ゲートの定義

サービスプロバイダの `boot()` でゲートを定義します。ゲートを作るのはフレームワーク側のプロバイダの登録処理なので、それより前に `make('gate')` を呼ぶと例外になります:

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

このプロバイダは `createApp({ providers })` に登録してください。

### ゲートの使用

コントローラには `this.authorize()` と `this.can()` があり、現在のユーザーの束縛まで済ませてくれます:

```typescript
// 拒否時は AuthorizationException (403) をスロー
await this.authorize('update-post', post)

// 例外を投げずにチェック
const canView = await this.can('view-dashboard')
```

それ以外の場所では、呼び出し元が持つコンテナからゲートを解決し、`forUser()` でユーザーを束縛します:

```typescript
const gate = this.container.make('gate').forUser(user)

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

すべてのゲートチェックの前に実行されるコールバックを登録します:

```typescript
this.container.make('gate').before((user, ability) => {
  // スーパー管理者はすべての操作が可能
  if (user?.isSuperAdmin) {
    return true
  }
  // undefined を返すとゲートのチェックに進む
})
```

### Afterコールバック

すべてのゲートチェックの後に実行されるコールバックを登録します:

```typescript
this.container.make('gate').after((user, ability, result) => {
  // 認可の試行をログに記録
  logger.info(`User ${user?.id} ${result ? 'allowed' : 'denied'} for ${ability}`)
})
```

## ポリシー

ポリシーは、特定のモデルやリソースを軸に認可ロジックを整理する仕組みです。

### ポリシーの作成

CLI でポリシーをスキャフォールドできます:

```bash
bunx guren make:policy Post
```

手書きする場合:

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

サービスプロバイダの `boot()` でゲートにポリシーを登録します:

```typescript
import { ServiceProvider } from '@guren/core'
import { PostPolicy } from '../Policies/PostPolicy'
import { Post } from '../Models/Post'

export default class AuthorizationProvider extends ServiceProvider {
  boot(): void {
    const gate = this.container.make('gate')

    // モデルクラスで登録
    gate.policy(Post, PostPolicy)

    // 文字列キーでも登録可能
    gate.policy('post', PostPolicy)
  }
}
```

### ポリシーの使用

ORM のクエリはコンストラクタ情報を持たないプレーンなオブジェクトを返すため、ポリシーを解決するにはモデルクラスをレコードと一緒に渡します:

```typescript
const gate = this.container.make('gate').forUser(user)
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

クラスインスタンス(`new` で生成したオブジェクト)はタプルなしで自動的にポリシーが解決されます:

```typescript
const canView = await gate.allows('view', somePostInstance)
```

### ポリシーメソッド

ポリシーは以下の標準メソッドをサポートします:

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

`before` メソッドを追加すると、すべてのポリシーチェックの前に割り込めます:

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

コントローラーには `authorize()` と `can()` ヘルパーが組み込まれています。現在のユーザーは認証コンテキストから自動的に解決されます(ゲストは `null`):

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

> **Tip:** `bunx guren make:feature Post --policy` を使うと、ポリシーの生成と `store`/`update`/`destroy` への `authorize()` 呼び出しの組み込みまで自動で行われます。

## ミドルウェア

ルートレベルのチェック用に認可ミドルウェアを作成できます:

```typescript
import { type Router, getRequestContainer, AuthorizationException, defineMiddleware } from '@guren/core'

export function authorizeAbility(ability: string) {
  return defineMiddleware(async (ctx, next) => {
    const user = ctx.get('user') ?? null
    const gate = getRequestContainer(ctx).make('gate')

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

## ベストプラクティス

1. **モデル固有のロジックにはポリシーを使う** - 認可をモデル単位で整理できます。
2. **ゲートは小さく保つ** - 特定のモデルに紐づかないアビリティ向けです。
3. **重いチェックはキャッシュする** - 認可にデータベースクエリが要るならキャッシュを検討します。
4. **before コールバックは控えめに** - 多用するとデバッグが難しくなります。
5. **認可をテストする** - ゲートとポリシーのテストを書きます。

## 認可のテスト

グローバルインスタンスに依存せず、テストごとに新しい `Gate` を生成します:

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
