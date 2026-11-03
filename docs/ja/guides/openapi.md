# OpenAPI

ルートの定義から、OpenAPI 3.1 のドキュメントを生成できます。スキーマは各ルートの[コントラクト](./route-contracts.md)から取り、ドキュメントにだけ使う注釈をいくつか書き足せます。オプションの `@guren/openapi` パッケージを入れると、ドキュメントをファイルに書き出せるほか、対話式のドキュメント UI と合わせてアプリから配信することもできます。

## ドキュメントの生成

オプションの `@guren/openapi` パッケージをインストールすると、ルート定義からスペックを生成できます。

```bash
bun add @guren/openapi
bunx guren openapi:generate
```

このコマンドはルートファイルを読み取り、ルートコントラクトから Zod スキーマと OpenAPI メタデータを取り出して、OpenAPI 3.1 の JSON ドキュメントを `.guren/openapi.gen.json` に書き出します。

## OpenAPI メタデータ

ルートコントラクトには、簡単な OpenAPI のアノテーションも指定できます。指定した内容はルート定義に保存され、オプションの `@guren/openapi` プラグインが OpenAPI 3.1 のドキュメントを生成するときに使われます。

```ts
router.post('/posts', {
  body: CreatePostSchema,
  output: PostResponseSchema,
  name: 'posts.store',
  summary: 'Create a post',
  description: 'Creates a new blog post.',
  tags: ['Posts'],
}, [PostsController, 'store'])

router.get('/posts/:id', {
  params: PostIdParams,
  name: 'posts.show',
  summary: 'Get a post',
  tags: ['Posts'],
  deprecated: false,
}, [PostsController, 'show'])
```

使える OpenAPI のフィールドは次のとおりです。

| フィールド | 型 | 用途 |
|-----------|------|------|
| `summary` | `string` | ドキュメント UI に表示される短い説明 |
| `description` | `string` | エンドポイントの詳細な説明 |
| `tags` | `string[]` | ドキュメント UI でエンドポイントをグループ化 |
| `operationId` | `string` | 自動生成されるオペレーション ID を上書き |
| `deprecated` | `boolean` | エンドポイントを非推奨としてマーク |

## CLI オプション

```bash
# タイトルとバージョンを指定
bunx guren openapi:generate --title "Blog API" --version "1.0.0"

# 出力パスを変更
bunx guren openapi:generate --out docs/openapi.json

# サーバー URL を含める
bunx guren openapi:generate --server "https://api.example.com"

# 既存ファイルを上書き
bunx guren openapi:generate --force
```

## ランタイムでのドキュメントマウント

OpenAPI のスペックと、操作できるドキュメント UI を、アプリケーションから直接配信することもできます。

```ts
import { createApp } from '@guren/core'
import { mountOpenApiDocs } from '@guren/openapi'

const app = createApp({ routes: registerWebRoutes })

mountOpenApiDocs(app, {
  title: 'Blog API',
  version: '1.0.0',
})
```

次の 2 つのエンドポイントがマウントされます。

| パス | 説明 |
|-----|------|
| `/openapi.json` | 生成された OpenAPI 3.1 JSON ドキュメント |
| `/docs` | インタラクティブな API ドキュメント UI（Scalar） |

パスは `jsonPath` と `docsPath` オプションで変更できます。

```ts
mountOpenApiDocs(app, {
  title: 'Blog API',
  version: '1.0.0',
  jsonPath: '/api/openapi.json',
  docsPath: '/api/docs',
})
```

`Application` のインスタンスにマウントする場合、ルート定義はルーターから自動で読み取られます。素の Hono のインスタンスにマウントする場合は、`definitions` を明示的に渡してください。

`servers` オプションには、配列のほかに関数も渡せます。マウントしたドキュメントはリクエストのたびに生成され、関数もそのつど呼ばれるので、マウントした時点ではまだ分からないアドレスも載せられます。たとえば `PORT=0` の場合はポートを OS が割り当てるので、`listen()` が返るまでポート番号が決まりません。固定の配列を渡していると、ドキュメントも、そこから生成したクライアントも、何も待ち受けていないアドレスを指したままになってしまいます。

```ts
mountOpenApiDocs(app, {
  title: 'Blog API',
  version: '1.0.0',
  servers: () => [app.address?.url ?? 'http://localhost:3000'],
})

await app.listen({ port: 0 })
```

`app.address` は `listen()` がこのアプリをバインドしたアドレスで、バインドする前は `undefined` です。関数はリクエストのたびに呼ばれるので、`listen()` がアドレスを決めた後で読むことになります。素の Hono のインスタンスには問い合わせる `Application` がないので、そのアプリが知っている方法でアドレスを返してください。
