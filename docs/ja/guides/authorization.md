# 認可

認可は、認証済みユーザーが実行できる操作を制御する仕組みです。Guren は Laravel に着想を得たポリシーベースの認可システムを提供しています。

## ゲート

ゲートは、ユーザーが特定のアクションを実行することを許可されているかどうかを判断するシンプルなクロージャです。

### ゲートの定義

`Gate`クラスを使用してゲートを定義します。

```typescript
import { Gate } from '@guren/core'

// シンプルなゲート
Gate.define('view-dashboard', (user) => {
  return user.isAdmin
})

// リソース付きゲート
Gate.define('update-post', (user, post) => {
  return user.id === post.userId
})

// データベースチェック付き非同期ゲート
Gate.define('delete-comment', async (user, comment) => {
  const post = await Post.find(comment.postId)
  return user.id === post?.userId
})
```

### ゲートの使用

ゲートメソッドを使用して認可をチェックします。

```typescript
import { Gate } from '@guren/core'

// 許可されているかチェック
const canView = await Gate.allows('view-dashboard', user)

// 拒否されているかチェック
const cannotView = await Gate.denies('view-dashboard', user)

// リソース付き
const canUpdate = await Gate.allows('update-post', user, post)

// 認可を確認し、拒否された場合は例外をスロー
await Gate.authorize('update-post', user, post)
// 拒否された場合 AuthorizationException をスロー
```

### Beforeコールバック

すべてのゲートチェックの前に実行されるコールバックを登録します。

```typescript
Gate.before((user, ability) => {
  // スーパー管理者は全て実行可能
  if (user.isSuperAdmin) {
    return true
  }
  // undefined を返すと通常のゲート判定に進みます
})
```

### Afterコールバック

すべてのゲートチェックの後に実行されるコールバックを登録します。

```typescript
Gate.after((user, ability, result) => {
  // 認可の試行をログに記録
  logger.info(`ユーザー ${user.id} は ${ability} を ${result ? '許可' : '拒否'} されました`)
})
```

## ポリシー

ポリシーは特定のモデルまたはリソースに関する認可ロジックを整理します。

### ポリシーの作成

```typescript
import { Policy } from '@guren/core'
import type { User } from '../Models/User'
import type { Post } from '../Models/Post'

export class PostPolicy extends Policy<User, Post> {
  /**
   * ユーザーが投稿を閲覧できるかどうかを判断します。
   */
  viewAny(user: User): boolean {
    return true
  }

  /**
   * ユーザーが投稿を閲覧できるかどうかを判断します。
   */
  view(user: User, post: Post): boolean {
    return post.published || user.id === post.userId
  }

  /**
   * ユーザーが投稿を作成できるかどうかを判断します。
   */
  create(user: User): boolean {
    return user.verified
  }

  /**
   * ユーザーが投稿を更新できるかどうかを判断します。
   */
  update(user: User, post: Post): boolean {
    return user.id === post.userId
  }

  /**
   * ユーザーが投稿を削除できるかどうかを判断します。
   */
  delete(user: User, post: Post): boolean {
    return user.id === post.userId
  }

  /**
   * ユーザーが投稿を復元できるかどうかを判断します。
   */
  restore(user: User, post: Post): boolean {
    return user.id === post.userId
  }

  /**
   * ユーザーが投稿を完全に削除できるかどうかを判断します。
   */
  forceDelete(user: User, post: Post): boolean {
    return user.isAdmin
  }
}
```

### ポリシーの登録

Gateクラスにポリシーを登録します。

```typescript
import { Gate } from '@guren/core'
import { PostPolicy } from './Policies/PostPolicy'
import { Post } from './Models/Post'

// モデルクラスで登録
Gate.policy(Post, new PostPolicy())

// または文字列キーで登録
Gate.policy('post', new PostPolicy())
```

### ポリシーの使用

```typescript
// Gate経由でポリシーをチェック
const canUpdate = await Gate.allows('update', user, post)

// またはforUserでチェーン可能なチェック
const canDelete = await Gate.forUser(user).allows('delete', post)

// 例外付き認可
await Gate.forUser(user).authorize('update', post)
```

### ポリシーメソッド

ポリシーは以下の標準メソッドをサポートしています。

| メソッド | 説明 |
|--------|-------------|
| `viewAny` | すべてのリソースを閲覧可能か |
| `view` | 特定のリソースを閲覧可能か |
| `create` | 新しいリソースを作成可能か |
| `update` | リソースを更新可能か |
| `delete` | リソースを削除可能か |
| `restore` | ソフト削除されたリソースを復元可能か |
| `forceDelete` | リソースを完全に削除可能か |

### Beforeメソッド

すべてのポリシーチェックをインターセプトする`before`メソッドを追加します。

```typescript
export class PostPolicy extends Policy<User, Post> {
  before(user: User, ability: string): boolean | undefined {
    // 管理者は投稿に対して何でもできる
    if (user.isAdmin) {
      return true
    }
    // undefined を返すと個別のポリシーメソッドで判定します
  }
}
```

## コントローラー統合

コントローラーで認可を使用します。

```typescript
import { Controller, Gate } from '@guren/core'
import { PostResource } from '@/app/Http/Resources/PostResource'
import { pages } from '@/.guren/pages.gen'

export default class PostController extends Controller {
  async show(id: number) {
    const post = await Post.find(id)

    // Gateを使用して認可
    await Gate.authorize('view', this.user(), post)

    return this.inertia(pages.posts.Show, { post: new PostResource(post).toJSON() })
  }

  async update(id: number) {
    const post = await Post.find(id)

    // 手動で権限をチェック
    if (await Gate.denies('update', this.user(), post)) {
      return this.json({ error: 'Unauthorized' }, 403)
    }

    // 更新ロジック...
  }
}
```

## ミドルウェア

ルートレベルのチェック用認可ミドルウェアを作成します。

```typescript
import { Router, Gate, AuthorizationException } from '@guren/core'

export function authorize(ability: string) {
  return async (ctx, next) => {
    const user = ctx.get('user')

    if (!user || await Gate.denies(ability, user)) {
      throw new AuthorizationException()
    }

    return next()
  }
}

// ルートでの使用
export function registerWebRoutes(router: Router): void {
  router.get('/admin', [AdminController, 'index']).middleware(authorize('access-admin'))
}
```

## ベストプラクティス

1. **モデル固有のロジックにはポリシーを使用** - モデルごとに認可を整理します。
2. **ゲートはシンプルに** - 特定のモデルに紐付かない能力にはゲートを使用します。
3. **高コストなチェックはキャッシュ** - 認可にデータベースクエリが必要な場合、キャッシュを検討します。
4. **beforeコールバックは控えめに** - 使いすぎるとデバッグが難しくなります。
5. **認可をテスト** - ゲートとポリシーのテストを書きます。

## 認可のテスト

```typescript
import { describe, it, expect, beforeEach } from 'bun:test'
import { Gate } from '@guren/core'

describe('PostPolicy', () => {
  beforeEach(() => {
    Gate.clear()
    Gate.policy('post', new PostPolicy())
  })

  it('所有者は投稿を更新できる', async () => {
    const user = { id: 1 }
    const post = { id: 1, userId: 1 }

    expect(await Gate.allows('update', user, post)).toBe(true)
  })

  it('非所有者は投稿を更新できない', async () => {
    const user = { id: 2 }
    const post = { id: 1, userId: 1 }

    expect(await Gate.denies('update', user, post)).toBe(true)
  })
})
```
