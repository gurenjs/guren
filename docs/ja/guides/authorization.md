# 認可

認可は、認証済みユーザーが実行できる操作を制御する仕組みです。Guren は Laravel に着想を得たポリシーベースの認可システムを提供しています。

認可ゲートはアプリの起動時に自動的に作成されます。起動後はどこからでも `getGate()` を呼び出してアビリティの定義やポリシーの登録ができます。手動のセットアップは不要です。

## ゲート

ゲートは、ユーザーが特定のアクションを実行することを許可されているかどうかを判断するシンプルなクロージャです。

### ゲートの定義

`src/app.ts`(boot コールバック内)またはサービスプロバイダでゲートを定義します:

```typescript
import { getGate } from '@guren/core'

const gate = getGate()

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
```

### ゲートの使用

`forUser()` でユーザーを束縛してから認可をチェックします:

```typescript
import { getGate } from '@guren/core'

const gate = getGate().forUser(user)

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
getGate().before((user, ability) => {
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
getGate().after((user, ability, result) => {
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

`src/app.ts`(boot コールバック内)またはサービスプロバイダでゲートにポリシーを登録します:

```typescript
import { getGate } from '@guren/core'
import { PostPolicy } from '../app/Policies/PostPolicy'
import { Post } from '../app/Models/Post'

// モデルクラスで登録
getGate().policy(Post, PostPolicy)

// 文字列キーでも登録可能
getGate().policy('post', PostPolicy)
```

### ポリシーの使用

ORM のクエリはコンストラクタ情報を持たない平オブジェクトを返すため、ポリシーを解決するにはモデルクラスをレコードと一緒に渡します:

```typescript
import { getGate } from '@guren/core'

const gate = getGate().forUser(user)
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

> **Tip:** `bunx guren make:feature Post --policy` を使うと、ポリシーの生成と `store`/`update` への `authorize()` 呼び出しの組み込みまで自動で行われます。

## ミドルウェア

ルートレベルのチェック用に認可ミドルウェアを作成できます:

```typescript
import { type Router, getGate, AuthorizationException, defineMiddleware } from '@guren/core'

export function authorizeAbility(ability: string) {
  return defineMiddleware(async (ctx, next) => {
    const user = ctx.get('user') ?? null

    if (await getGate().forUser(user).denies(ability)) {
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

1. **モデル固有のロジックにはポリシーを使う** - 認可をモデル単位で整理する。
2. **ゲートはシンプルに保つ** - 特定のモデルに紐づかないアビリティに使う。
3. **高コストなチェックはキャッシュする** - 認可にデータベースクエリが必要な場合はキャッシュを検討する。
4. **before コールバックは控えめに** - 多用するとデバッグが難しくなる。
5. **認可をテストする** - ゲートとポリシーのテストを書く。

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
