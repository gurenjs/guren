# APIリソース

APIリソースは、モデルとAPIレスポンス間の変換レイヤーを提供します。データがJSONにシリアライズされる方法を細かく制御できます。

## 基本的な使い方

`Resource`クラスを継承してリソースを作成します：

```typescript
import { Resource } from '@guren/core'
import type { User } from '../Models/User'

export class UserResource extends Resource<User> {
  toArray() {
    return {
      id: this.resource.id,
      name: this.resource.name,
      email: this.resource.email,
      createdAt: this.resource.createdAt?.toISOString(),
    }
  }
}
```

### コントローラーでの使用

```typescript
import { Controller } from '@guren/core'
import { UserResource } from '../Resources/UserResource'

export default class UserController extends Controller {
  async show(id: number) {
    const user = await User.find(id)

    return this.json({
      data: new UserResource(user).toJSON(),
    })
  }

  async index() {
    const users = await User.all()

    return this.json({
      data: UserResource.collection(users),
    })
  }
}
```

## 条件付きフィールド

リソースは条件付きでフィールドを含めるためのヘルパーメソッドを提供します。

### when()

条件がtrueの場合のみフィールドを含めます。

```typescript
export class UserResource extends Resource<User> {
  toArray() {
    return {
      id: this.resource.id,
      name: this.resource.name,
      // 認証済みユーザーのみメールを含める
      email: this.when(this.resource.verified, this.resource.email),
      // 計算値にはコールバックを使用
      role: this.when(this.resource.isAdmin, () => 'admin'),
    }
  }
}
```

### whenLoaded()

リレーションがロードされている場合のみフィールドを含めます。

```typescript
export class PostResource extends Resource<Post> {
  toArray() {
    return {
      id: this.resource.id,
      title: this.resource.title,
      // authorリレーションがロードされている場合のみ含める
      author: this.whenLoaded('author', () => ({
        id: this.resource.author?.id,
        name: this.resource.author?.name,
      })),
      // ロード時にネストされたリソースを含める
      comments: this.whenLoaded('comments', () =>
        CommentResource.collection(this.resource.comments)
      ),
    }
  }
}
```

### whenNotNull()

nullでない場合のみフィールドを含めます。

```typescript
export class ProfileResource extends Resource<Profile> {
  toArray() {
    return {
      id: this.resource.id,
      bio: this.whenNotNull(this.resource.bio),
      avatarUrl: this.whenNotNull(this.resource.avatarUrl),
    }
  }
}
```

### whenOr()

デフォルト値付きでフィールドを含めます。

```typescript
export class SettingsResource extends Resource<Settings> {
  toArray() {
    return {
      theme: this.whenOr(
        this.resource.theme !== undefined,
        this.resource.theme,
        'light' // デフォルト値
      ),
    }
  }
}
```

## 追加データ

リソースレスポンスに追加データを加えます。

```typescript
const resource = new UserResource(user)
  .additional({
    permissions: ['read', 'write'],
    meta: { version: '1.0' },
  })

return this.json({ data: resource.toJSON() })
// { id: 1, name: 'John', ..., permissions: [...], meta: {...} }
```

## リソースコレクション

モデルの配列をリソースに変換します。

```typescript
// 静的メソッド
const users = await User.all()
const data = UserResource.collection(users)

// またはcollectヘルパーを使用
import { collect } from '@guren/core'
const data = collect(users, UserResource)
```

## ページネーション

Guren は2つのページネーション戦略を提供します。

### オフセットベースページネーション

ページ番号を使用した従来のページネーションです。

```typescript
import { paginate, Paginator } from '@guren/core'

export default class UserController extends Controller {
  async index() {
    const page = Number(this.request.query('page') ?? 1)
    const perPage = Number(this.request.query('per_page') ?? 15)

    const result = await User.paginate({ page, perPage })

    const paginator = paginate(result, {
      path: '/api/users',
      query: { per_page: String(result.meta.perPage) },
    })

    return this.json(paginator.toResource(UserResource))
  }
}
```

**レスポンス形式：**

```json
{
  "data": [
    { "id": 1, "name": "John" },
    { "id": 2, "name": "Jane" }
  ],
  "meta": {
    "currentPage": 1,
    "lastPage": 5,
    "perPage": 15,
    "total": 75,
    "from": 1,
    "to": 15
  },
  "links": {
    "first": "/api/users?page=1&per_page=15",
    "last": "/api/users?page=5&per_page=15",
    "prev": null,
    "next": "/api/users?page=2&per_page=15",
    "pages": [
      { "page": 1, "url": "/api/users?page=1&per_page=15", "active": true },
      { "page": 2, "url": "/api/users?page=2&per_page=15", "active": false }
    ]
  }
}
```

### カーソルベースページネーション

無限スクロールやリアルタイムデータに最適です。

```typescript
import { cursorPaginate, CursorPaginator } from '@guren/core'

export default class PostController extends Controller {
  async index() {
    const cursor = this.request.query('cursor')
    const perPage = Number(this.request.query('per_page') ?? 20)

    const posts = await Post.query()
      .where('id', '>', decodeCursor(cursor) ?? 0)
      .orderBy('id', 'asc')
      .limit(perPage + 1)
      .all()

    const hasMore = posts.length > perPage
    const items = hasMore ? posts.slice(0, perPage) : posts

    const paginator = CursorPaginator.fromArray(items, cursor, perPage)

    return this.json(paginator.toResource(PostResource))
  }
}
```

**レスポンス形式：**

```json
{
  "data": [
    { "id": 101, "title": "Post 1" },
    { "id": 102, "title": "Post 2" }
  ],
  "meta": {
    "perPage": 20,
    "nextCursor": "MTAy",
    "prevCursor": null,
    "hasMore": true
  }
}
```

## Paginatorメソッド

### オフセットPaginator

| メソッド | 説明 |
|--------|-------------|
| `items()` | ページネートされたアイテムを取得 |
| `total()` | 総アイテム数を取得 |
| `perPage()` | ページあたりのアイテム数を取得 |
| `currentPage()` | 現在のページ番号を取得 |
| `lastPage()` | 最終ページ番号を取得 |
| `hasMorePages()` | 次のページが存在するか確認 |
| `onFirstPage()` | 最初のページか確認 |
| `onLastPage()` | 最後のページか確認 |
| `firstItem()` | 最初のアイテムインデックス（1ベース） |
| `lastItem()` | 最後のアイテムインデックス（1ベース） |
| `meta()` | ページネーションメタデータを取得 |
| `links()` | ページネーションリンクを取得 |
| `withPath(path)` | ベースURLパスを設定 |
| `withQuery(query)` | クエリパラメータを追加 |
| `toResource(Class)` | リソースクラスで変換 |
| `toJSON()` | 生のページネートレスポンスを取得 |

### カーソルPaginator

| メソッド | 説明 |
|--------|-------------|
| `items()` | ページネートされたアイテムを取得 |
| `perPage()` | ページあたりのアイテム数を取得 |
| `currentCursor()` | 現在のカーソルを取得 |
| `nextCursor()` | 次ページのカーソルを取得 |
| `prevCursor()` | 前ページのカーソルを取得 |
| `hasMorePages()` | 次のページが存在するか確認 |
| `meta()` | カーソルページネーションメタデータを取得 |
| `toResource(Class)` | リソースクラスで変換 |

## JsonResource

カスタムクラスなしで簡単に変換できます。

```typescript
import { JsonResource } from '@guren/core'

const user = { id: 1, name: 'John', password: 'secret' }
const resource = new JsonResource(user)
// 戻り値: { id: 1, name: 'John', password: 'secret' }
```

## リソースの生成

CLIを使用して新しいリソースを生成します。

```bash
bunx guren make:resource User
# 作成: app/Http/Resources/UserResource.ts
```

## Resource から API レスポンスを型付けする

`guren codegen` は各 Resource の形を `.guren/data.gen.ts` に抽出します（`Data.Post`、`Data.User` など）。Resource で応答するルートは、ルートコントラクトで Resource を指名するだけで、その形をレスポンス型として宣言できます。Zod スキーマも、フィールドの再記述も不要です:

```ts
router.query('/posts/search', {
  name: 'posts.search',
  body: PostSearchSchema,
  resource: { data: [PostResource] },
}, [PostController, 'search'])
```

生成された API クライアントは、このルートの `json()` を `{ data: Data.Post[] }` として型付けします。ヒントの書き方は [Resource レスポンスヒント](./routing.md#resource-レスポンスヒント)を参照してください。

### モジュール内の Resource

コード生成はプロジェクトルートの `app/Http/Resources` に加えて、各 `modules/<name>/` の中も走査します。モジュールの Resource はモジュール名を冠した名前で出力され、`modules/billing/app/Http/Resources/InvoiceResource.ts` は `Data.BillingInvoice` になります。この修飾は衝突したときだけでなく常に付きます。そうすることで型名は「クラスがどこにあるか」だけで決まり、別の場所に2つ目の `InvoiceResource` を追加してもフロントエンドが既にインポートしている型名が変わることはありません。

レスポンスヒントが持つ情報は Resource のクラス名だけなので、2つのアプリルートが同じ `InvoiceResource` を宣言しているとヒントは解決できません。この場合はコード生成が両方のファイル名を挙げて警告し、どちらのモジュールのペイロードなのかを推測せず、そのルートのレスポンスを型無しのままにします。解消するにはどちらかのクラス名を変更してください。

## ベストプラクティス

1. **リソースを焦点化** - モデル変換ごとに1つのリソース
2. **リレーションにはwhenLoadedを使用** - ロードされたリレーションのみ含めてN+1問題を防止
3. **日付を一貫して変換** - 日付フィールドには`.toISOString()`を使用
4. **機密データを隠す** - パスワード、トークン、内部IDを公開しない
5. **大規模データセットにはカーソルページネーション** - オフセットより高パフォーマンス
