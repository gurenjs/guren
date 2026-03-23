# 10分で最初の機能を作る

このガイドでは、Guren の推奨パターンに沿って進めます。`@guren/core`、`bunx guren add ...`、page definition、resource 出力、route/page manifest を前提にしています。

## 作るもの

次の要素を持つ小さな posts 機能です。

- 認証 scaffolding
- posts 用の resource stack
- 型付き route/page manifest
- Guren 標準フローで動く SSR アプリ

## 1. アプリを作る

```bash
bunx create-guren-app posts-app --mode ssr
cd posts-app
bun install
```

## 2. 標準の機能スタックを追加する

```bash
bunx guren add auth
bunx guren add resource posts
bunx guren add queue
bunx guren add mail
bunx guren add events
bunx guren add cache
bunx guren add notifications
bunx guren add storage
bunx guren add broadcasting
bunx guren add schedule
```

これで次が生成されます。

- `AuthProvider`、login/profile controller、validator、routes、page definitions
- `PostController`、`PostResource`、`PostValidator`、CRUD pages、named routes
- `QueueProvider`、`MailProvider`、`EventProvider`、`CacheProvider`、`NotificationProvider`、`StorageProvider`、`BroadcastProvider`、`app/Console/Kernel.ts` など、標準の非同期/運用系機能
- 各ページコンポーネントの `Props` から自動生成される `.guren/pages.gen.ts`（Inertia page props の型情報源）

## 3. 型付き manifest を生成する

```bash
bun run codegen
```

`codegen` は次を生成します。

- named route helper 用の `.guren/routes.gen.ts`
- 型付き page definitions 用の `.guren/pages.gen.ts`
- editor 補助用の `types/generated/routes.d.ts`

## 4. データベースを準備する

PostgreSQL を使える状態にしてから、次を実行します。

```bash
bun run db:migrate
bun run db:seed
```

## 5. アプリを起動する

```bash
bun run dev
```

次を開いて確認します。

- `/login` で生成された認証フロー
- `/posts` で生成された resource フロー

## 6. データフローを理解する

標準の resource scaffold は、次のデータフローで動きます。

1. `db/schema.ts` が Drizzle table を定義する
2. `app/Models/Post.ts` が typed model を公開する
3. `app/Http/Resources/PostResource.ts` が response shape を定義する
4. 各ページコンポーネントで Props を定義し、codegen が `.guren/pages.gen.ts` に自動抽出する
5. `app/Http/Controllers/PostController.ts` が input を検証し、resource 出力を返す

一覧ページの標準的なデータ構造はこうです。

```ts
type Props = PaginatedPageProps<PostResourceData>
```

つまりページは次を受け取ります。

- `data`
- `pagination.meta`
- `pagination.links`

controller や UI 側で pagination state を組み直す必要はありません。

## 7. 次に触る場所

- post の項目を増やすなら `db/schema.ts`
- create/update ルールを変えるなら `app/Http/Validators/PostValidator.ts`
- page/API の出力を変えるなら `app/Http/Resources/PostResource.ts`
- UI を変えるなら `resources/js/pages/posts/*.tsx`

## 8. 推奨する考え方

新しい機能を追加するときは、まずこの流れを使います。

```bash
bunx guren add resource comments
bun run codegen
```

その上で各レイヤーの責務を固定します。

- model は data access
- validator は input parsing
- resource は output shaping
- page component は props 定義
- controller は response composition

これが、Guren が目指している Rails/Laravel 的な DX を実現するための基本パターンです。
