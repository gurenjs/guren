# フロントエンドガイド

Guren は Inertia.js と React を組み合わせ、単一ページアプリの体験を提供します。コントローラーは Inertia レスポンスを返し、フロントエンドは `resources/js/pages/` 配下の React コンポーネントを描画します。

## プロジェクト構成
- `resources/js/app.tsx`: Inertia アプリのブートストラップとグローバルプロバイダー登録。
- `resources/js/ssr.tsx`: SSR 有効時にバックエンドが利用するサーバーレンダラーをエクスポート。
- `resources/js/pages/`: コントローラー応答に対応する React コンポーネント。
- `resources/js/components/`: 共有 UI コンポーネント（推奨）。
- `resources/css/app.css`: Tailwind など CSS のエントリーポイント。

## ページコンポーネント
ファイル名は `.guren/pages.gen.ts` に自動生成される page definitions と対応します。Props は各ページコンポーネントで `interface Props` として定義し、codegen で抽出されます。

```ts
// Controller
return this.inertia(pages.posts.Index, {
  data,
  pagination,
})
```

```tsx
// resources/js/pages/posts/Index.tsx
import type { PageProps } from '@guren/inertia-client/contracts'
import { Head, Link } from '@inertiajs/react'
import { pages } from '@/.guren/pages.gen'

type Props = PageProps<typeof pages.posts.Index>

export default function Index({ data, pagination }: Props) {
  return (
    <>
      <Head title="Posts" />
      <div className="space-y-4">
        {data.map((post) => (
          <article key={post.id} className="rounded border border-slate-200 p-4">
            <h2 className="text-lg font-semibold">{post.title}</h2>
            <p className="text-slate-600">{post.excerpt}</p>
            <Link className="text-blue-600 underline" href={`/posts/${post.id}`}>
              Read more
            </Link>
          </article>
        ))}
      </div>
      <p className="mt-4 text-sm text-slate-500">{pagination.meta.total} posts</p>
    </>
  )
}
```

TypeScript で props を型付けするとコンパイル時の安全性が高まります。

## レイアウトと共有 UI
ナビゲーションや共通 UI を保つため、ページをレイアウトコンポーネントでラップします。

```tsx
// resources/js/components/Layout.tsx
export function Layout({ children }: React.PropsWithChildren) {
  return (
    <div className="min-h-screen bg-slate-50">
      <header className="border-b bg-white">
        <div className="mx-auto flex max-w-4xl items-center justify-between px-6 py-4">
          <a href="/">Guren</a>
        </div>
      </header>
      <main className="mx-auto max-w-4xl px-6 py-10">{children}</main>
    </div>
  )
}
```

```tsx
// resources/js/pages/posts/Index.tsx
import { Layout } from '@/resources/js/components/Layout'

export default function Index({ posts }: Props) {
  return (
    <Layout>
      {/* page content */}
    </Layout>
  )
}
```

## フォームとナビゲーション
Inertia のヘルパーでクライアントナビゲーションとフォーム送信を行います。

- `<Link href="/posts/new">Create Post</Link>` でページ遷移してもフルリロードされません。
- `const form = useForm({ title: '', body: '' })` でフォーム状態を管理。
- `form.post('/posts')` で送信。

バリデーションエラーはコントローラーから返し、クライアント側で `form.errors` を参照します。

## アセットとスタイル
スキャフォールドには Tailwind CSS が設定済みです。`resources/css/app.css` を編集するか、好みの CSS フレームワークを追加してください。画像やフォントなどの追加アセットは `public/` 配下に置きます。

## サーバーサイドレンダリング
各アプリには既定で `resources/js/ssr.tsx` が入り、`@guren/inertia-client` の `renderInertiaServer()` を呼び出します。`autoConfigureInertiaAssets(app, { importMeta })` でブートすると、Guren は次を自動で処理します。

- 開発時は `bun run dev` と一緒に Vite dev サーバーを自動起動して管理します。
- `VITE_DEV_SERVER_URL` は、既に起動している外部 Vite dev サーバーへ明示的に向けたい場合だけ使います。
- 本番ではビルド済みクライアントマニフェスト (`public/assets/.vite/manifest.json`) を検出し、`GUREN_INERTIA_ENTRY`/`GUREN_INERTIA_STYLES` を設定。
- SSR マニフェスト (`public/assets/.vite/ssr-manifest.json`) を検出し、`GUREN_INERTIA_SSR_ENTRY` / `GUREN_INERTIA_SSR_MANIFEST` を設定してサーバーレンダリングを可能にします。

必要なアセットを生成するには `codegen` を含む標準 build を実行します。

```bash
bun run build
```

コンポーネント解決をカスタムしたい場合は `resources/js/ssr.tsx` を編集し、`renderInertiaServer()` に別の `resolve` を渡します。`autoConfigureInertiaAssets` を使わない場合は、`configureInertiaAssets` を呼ぶ前に必要な環境変数を自前でセットしてください。

## 型安全

Guren はコントローラーとページコンポーネント間のエンドツーエンド型安全を自動 codegen パイプラインで実現します。

### 型の流れ

```
ページコンポーネント      codegen              コントローラー
┌──────────────┐    ┌──────────────┐    ┌──────────────────┐
│ interface Props    │ pages.gen.ts │    │ this.inertia(     │
│ {             │ ──►│ PagePropsMap │───►│   pages.posts.Show│
│   post: Post  │    │ PageContract │    │   { post }        │
│ }             │    └──────────────┘    │ ) // 型チェック済み│
└──────────────┘                        └──────────────────┘
```

1. **ページコンポーネントで Props を定義** — 各ページが受け取るデータを `interface Props` で宣言します:

```tsx
// resources/js/pages/posts/Show.tsx
import type { PostResourceData } from '@/Http/Resources/PostResource'

interface Props {
  post: PostResourceData
}

export default function Show({ post }: Props) {
  return <h1>{post.title}</h1>
}
```

2. **codegen が Props を抽出** — `bun run codegen`（`bun run dev` 時にも自動実行）がすべてのページコンポーネントをスキャンし、`interface Props` を抽出して `.guren/pages.gen.ts` に書き出します:

```ts
// .guren/pages.gen.ts（自動生成）
export interface PagePropsMap {
  'posts/Show': { post: PostResourceData }
}

export const pages = {
  posts: {
    Show: defineGeneratedPage<'posts/Show', PagePropsMap['posts/Show']>(...)
  }
}
```

3. **コントローラーが型チェックされる** — コントローラーが `this.inertia(pages.posts.Show, { ... })` を呼ぶと、TypeScript が第二引数を `PageContract` の Props 型と照合します。プロパティの不足や型の不一致はコンパイルエラーになります:

```ts
// app/Http/Controllers/PostController.ts
import { pages } from '@/.guren/pages.gen'

export default class PostController extends Controller {
  async show() {
    const post = await Post.findOrFail(id)
    // ✅ 型チェック済み: { post } は Show.tsx の Props と一致する必要がある
    return this.inertia(pages.posts.Show, { post: new PostResource(post).toJSON() })
  }
}
```

### Props でのローカル型の使用

Props はローカルに定義した型を参照できます。codegen が自動的に収集します:

```tsx
type Author = { id: number; name: string }

interface Props {
  post: { title: string; author: Author }
}
```

`Author` と `Props` の両方が `pages.gen.ts` に抽出されます。

### Props でのインポート型の使用

Resource ファイルなど外部モジュールからインポートした型も追跡されます:

```tsx
import type { PostResourceData } from '@/Http/Resources/PostResource'

interface Props {
  post: PostResourceData
}
```

codegen がインポートパスを書き換え、`pages.gen.ts` から同じ型を参照できるようにします。

### Tips

- バックエンドとフロントエンドで型を共有するため、モデルから Drizzle 推論型を再エクスポートします（例: `export type PostRecord = typeof posts.$inferSelect`）。
- 長い相対パスの代わりに `@/` エイリアスを使います。`tsconfig.json` の `@/*` → `./*` マッピングがサーバーとエディターを、Guren Vite プラグインが登録する同名エイリアスがフロントエンドビルドをカバーするため、`@/.guren/routes.gen` や `@/app/Http/Resources/PostResource` がどのレイヤーでも解決されます。
- Props を追加・変更した後は `bun run codegen` を実行して `pages.gen.ts` を更新してください。

## ホットリロード
`bun run dev` を実行するとフロントエンドとバックエンドが同期して動き、Bun が自動で Vite dev サーバーを起動するため TSX 変更は即時リロードされます。ワークフローを調整したい場合は `@guren/core/runtime` の `startViteDevServer()` を使って自前で Vite を制御できます。

これらのパターンでページとコンポーネントを構成すれば、React と Inertia だけでミニマムなボイラープレートの SPA 体験を得られます。
