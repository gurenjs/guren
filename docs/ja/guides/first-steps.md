# 10分で最初の機能を作る

このガイドでは、Guren の推奨フロー（golden path）に沿って認証付きブログアプリを構築します。

## 作るもの

次の要素を持つ小さな posts アプリです。

- 認証 scaffolding（ログイン、登録、プロフィール）
- posts の CRUD（一覧、詳細、作成、編集、削除）
- 型付き route/page manifest
- SSR で動くフルスタックアプリ

## 1. アプリを作る

```bash
bunx create-guren-app posts-app --mode ssr
cd posts-app
bun install
```

## 2. 認証とリソースを追加する

```bash
bunx guren add auth
bunx guren add resource posts --fields "title:string,body:text"
```

これで次が生成されます。

- `AuthProvider`、login/register/profile の Controller、Validator、routes、ページ
- `PostController`、`PostResource`、`PostValidator`、CRUD ページ、named routes
- `db/schema.ts` に posts テーブル定義が追加

## 3. 型付き manifest を生成する

```bash
bun run codegen
```

`codegen` は次を生成します。

- `.guren/routes.gen.ts` -- named route helper の型情報
- `.guren/pages.gen.ts` -- 型付き page props の定義
- `.guren/data.gen.ts` -- JsonResource の型情報
- `.guren/api-client.gen.ts` -- 型付き API クライアント

## 4. データベースを準備する

```bash
bun run db:migrate
bun run db:seed
```

デフォルトは SQLite のため、追加のセットアップは不要です。

## 5. 型チェックとビルド

```bash
bun run typecheck
bun run build
```

ここまででエラーがなければ、アプリの整合性が取れています。

## 6. アプリを起動する

```bash
bun run dev
```

次を開いて確認します。

- `/login` -- 生成された認証フロー（`demo@example.com` / `secret` でサインイン）
- `/posts` -- 生成された CRUD フロー

## 7. データフローを理解する

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

## 8. 次に触る場所

- post の項目を増やすなら `db/schema.ts`
- create/update ルールを変えるなら `app/Http/Validators/PostValidator.ts`
- page/API の出力を変えるなら `app/Http/Resources/PostResource.ts`
- UI を変えるなら `resources/js/pages/posts/*.tsx`

## 9. 推奨する考え方

新しい機能を追加するときは、まずこの流れを使います。

```bash
bunx guren add resource comments --fields "body:text,postId:number"
bun run codegen
bun run db:migrate
```

その上で各レイヤーの責務を固定します。

- model は data access
- validator は input parsing
- resource は output shaping
- page component は props 定義
- controller は response composition

これが、Guren が目指している Rails/Laravel 的な DX を実現するための基本パターンです。
