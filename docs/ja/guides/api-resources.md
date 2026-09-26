# APIリソース

APIリソースは、モデルを API レスポンスに変換する層です。モデルのデータをどういう JSON にするかを、フィールド単位で細かく決められます。

## 基本的な使い方

リソースは `Resource` クラスを継承して作ります。

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

リソースには、条件に応じてフィールドを出し分けるヘルパーメソッドがあります。

### when()

条件が true のときだけフィールドを含めます。

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

リレーションがロード済みのときだけフィールドを含めます。

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

値が null でないときだけフィールドを含めます。

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

デフォルト値を指定して、フィールドを含めます。

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

`additional()` を使うと、リソースのレスポンスに別のデータを追加できます。

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

モデルの配列は、まとめてリソースに変換できます。

```typescript
// 静的メソッド
const users = await User.all()
const data = UserResource.collection(users)

// またはcollectヘルパーを使用
import { collect } from '@guren/core'
const data = collect(users, UserResource)
```

## ページネーション

Guren のページネーションには 2 つの方式があります。

### オフセットベースページネーション

ページ番号で位置を指定する、よく使われる方式です。

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

無限スクロールや、頻繁に更新されるデータに向いています。

```typescript
import { Controller, CursorPaginator, decodeCursor, encodeCursor } from '@guren/core'

export default class PostController extends Controller {
  async index() {
    const cursor = this.query('cursor') ?? null
    const perPage = Number(this.query('per_page', '20'))
    const afterId = cursor ? Number(decodeCursor(cursor)) : 0

    // モデルのビルダーを使うので、グローバルスコープ(SoftDeletes やテナント)が掛かったまま
    const posts = await Post.where('id', '>', afterId)
      .orderBy('id', 'asc')
      .limit(perPage + 1)
      .get()

    const hasMore = posts.length > perPage
    const items = posts.slice(0, perPage)
    const paginator = new CursorPaginator(items, perPage, hasMore, {
      currentCursor: cursor,
      nextCursor: hasMore ? encodeCursor(items[items.length - 1].id) : null,
    })

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

専用のクラスを作らずに、簡単な変換だけを済ませたいときに使います。

```typescript
import { JsonResource } from '@guren/core'

const user = { id: 1, name: 'John', password: 'secret' }
const resource = new JsonResource(user)
// 戻り値: { id: 1, name: 'John', password: 'secret' }
```

## リソースの生成

新しいリソースは CLI で生成できます。

```bash
bunx guren make:resource User
# 作成: app/Http/Resources/UserResource.ts
```

## Resource から API レスポンスを型付けする

`guren codegen` を実行すると、各 Resource の形が `.guren/data.gen.ts` に `Data.Post` や `Data.User` として書き出されます。Resource を返すルートでは、ルートコントラクトに Resource を指定するだけで、その形をレスポンス型として宣言できます。Zod スキーマを書いたり、フィールドを並べ直したりする必要はありません。

```ts
router.query('/posts/search', {
  name: 'posts.search',
  body: PostSearchSchema,
  resource: { data: [PostResource] },
}, [PostController, 'search'])
```

生成される API クライアントでは、このルートの `json()` の型が `{ data: Data.Post[] }` になります。ヒントの書き方は [Resource レスポンスヒント](./routing.md#resource-レスポンスヒント)を参照してください。

### コード生成が読む形を宣言する

codegen は型をソースコードから直接読み取るので、ペイロードの型は Resource 自身のファイルに明記しておく必要があります。型注釈のない `toArray()` からオブジェクトリテラルを返すコードは、TypeScript としては正しくても codegen には形が読めません。`make:resource` が生成するコードと同じように、クラス名に合わせた interface を宣言し、`toArray()` の戻り値に注釈として付けてください。

```ts
export interface UserResourceData {
  id: number
  name: string
}

export class UserResource extends Resource<User, UserResourceData> {
  toArray(): UserResourceData {
    return { id: this.resource.id, name: this.resource.name }
  }
}
```

2 つ目の型引数はペイロードの型です。これを渡すと、`toJSON()` の戻り値も同じ型になります。省略すると `Record<string, unknown>` になるので、`toJSON()` の戻り値をそのままページや API クライアントに渡す場合は指定してください。

interface は Resource 自身のファイルで宣言してください。共通の型モジュールから import した interface は読み取られません。型を取り出せなかった Resource は、`guren codegen` の警告に名前が出ます。何も言わずに除外されることはないので、`Data.*` に型が生成されなかったときは必ず理由が分かります。

ペイロード型はプレーンな interface でなくても構いません。Zod スキーマから導いた型、交差型、宣言マージされた interface のように codegen が中身を書き写せない型でも、**エクスポート済み**のエイリアスであれば、宣言そのものを参照する形で出力されます。これを使えば、1 つのスキーマをランタイムのコントラクトとペイロード型の両方の元にできます。

```ts
export const UserResourceSchema = z.object({ id: z.number(), name: z.string() })
export type UserResourceData = z.infer<typeof UserResourceSchema>

export class UserResource extends Resource<User> {
  toArray(): UserResourceData {
    return UserResourceSchema.parse(this.resource)
  }
}
```

`data.gen.ts` は Resource のモジュールを経由して宣言を名前で参照するので、宣言はエクスポートしておく必要があります。また、参照には型引数を渡せないため、ジェネリック型はどちらの書き方でも扱えません。

### モジュール内の Resource

codegen はプロジェクトルートの `app/Http/Resources` に加えて、各 `modules/<name>/` の中も探します。モジュールの Resource はモジュール名を先頭に付けた名前で出力され、たとえば `modules/billing/app/Http/Resources/InvoiceResource.ts` は `Data.BillingInvoice` になります。モジュール名は名前が衝突したときに限らず、常に付きます。型名がクラスの置き場所だけで決まるので、別の場所に 2 つ目の `InvoiceResource` を追加しても、フロントエンドがすでに import している型名は変わりません。

レスポンスヒントに書けるのは Resource のクラス名だけです。そのため、2 つのアプリルートがどちらも `InvoiceResource` を宣言していると、ヒントがどちらを指すのか決まりません。この場合、codegen は両方のファイル名を挙げて警告し、どちらのモジュールのペイロードかを推測せずに、そのルートのレスポンスを型無しのままにします。解消するには、どちらかのクラス名を変えてください。

## ベストプラクティス

1. **リソースの役割を絞る**: 1 つのリソースには、モデルの変換を 1 種類だけ担当させます。
2. **リレーションには whenLoaded を使う**: ロード済みのリレーションだけを含めれば、N+1 問題を防げます。
3. **日付の変換をそろえる**: 日付フィールドには `.toISOString()` を使います。
4. **機密データを隠す**: パスワード、トークン、内部 ID は公開しないでください。
5. **大きなデータセットにはカーソルページネーションを使う**: オフセット方式より高速です。
