# フロントエンドガイド

Guren は Inertia.js と React を組み合わせ、単一ページアプリの体験を提供します。コントローラは Inertia レスポンスを返し、フロントエンドは `resources/js/pages/` 配下の React コンポーネントを描画します。

## プロジェクト構成
- `resources/js/app.tsx`: Inertia アプリのブートストラップとグローバルプロバイダー登録。
- `resources/js/ssr.tsx`: SSR 有効時にバックエンドが利用するサーバーレンダラーをエクスポート。
- `resources/js/pages/`: コントローラ応答に対応する React コンポーネント。
- `resources/js/components/`: 共有 UI コンポーネント（推奨）。
- `resources/css/app.css`: Tailwind など CSS のエントリーポイント。

## ページコンポーネント
ファイル名は `this.inertia()` に渡すコンポーネント名と対応します:

```ts
// Controller
return this.inertia('posts/Index', { posts })
```

```tsx
// resources/js/pages/posts/Index.tsx
import type { PostRecord } from '@/app/Models/Post'
import { Head, Link } from '@inertiajs/react'

type Props = {
  posts: PostRecord[]
}

export default function Index({ posts }: Props) {
  return (
    <>
      <Head title="Posts" />
      <div className="space-y-4">
        {posts.map((post) => (
          <article key={post.id} className="rounded border border-slate-200 p-4">
            <h2 className="text-lg font-semibold">{post.title}</h2>
            <p className="text-slate-600">{post.body}</p>
            <Link className="text-blue-600 underline" href={`/posts/${post.id}`}>
              Read more
            </Link>
          </article>
        ))}
      </div>
    </>
  )
}
```

TypeScript で props を型付けするとコンパイル時の安全性が高まります。

## レイアウトと共有 UI
ナビゲーションや共通 UI を保つため、ページをレイアウトコンポーネントでラップします:

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
Inertia のヘルパーでクライアントナビゲーションとフォーム送信を行います:

- `<Link href="/posts/new">Create Post</Link>` でページ遷移してもフルリロードされません。
- `const form = useForm({ title: '', body: '' })` でフォーム状態を管理。
- `form.post('/posts')` で送信。

バリデーションエラーはコントローラから返し、クライアント側で `form.errors` を参照します。

## アセットとスタイル
スキャフォールドには Tailwind CSS が設定済みです。`resources/css/app.css` を編集するか、好みの CSS フレームワークを追加してください。画像やフォントなどの追加アセットは `public/` 配下に置きます。

## サーバーサイドレンダリング
各アプリには既定で `resources/js/ssr.tsx` が入り、`@guren/inertia-client` の `renderInertiaServer()` を呼び出します。`autoConfigureInertiaAssets(app, { importMeta })` でブートすると、Guren は次を自動で処理します:

- 開発時は Vite dev サーバーへ HTML を向けます（`VITE_DEV_SERVER_URL` があれば使用）。
- 本番ではビルド済みクライアントマニフェスト (`public/assets/.vite/manifest.json`) を検出し、`GUREN_INERTIA_ENTRY`/`GUREN_INERTIA_STYLES` を設定。
- SSR マニフェスト (`public/assets/.vite/ssr-manifest.json`) を検出し、`GUREN_INERTIA_SSR_ENTRY` / `GUREN_INERTIA_SSR_MANIFEST` を設定してサーバーレンダリングを可能にします。

必要なアセットを生成するにはクライアントと SSR の両方をビルドします:

```bash
bunx vite build && bunx vite build --ssr
```

コンポーネント解決をカスタムしたい場合は `resources/js/ssr.tsx` を編集し、`renderInertiaServer()` に別の `resolve` を渡します。`autoConfigureInertiaAssets` を使わない場合は、`configureInertiaAssets` を呼ぶ前に必要な環境変数を自前でセットしてください。

## 型安全
- バックエンドとフロントエンドで型を共有するため、モデルから Drizzle 推論型を再エクスポートします（例: `export type PostRecord = typeof posts.$inferSelect`）。
- `tsconfig.json` で設定したパスエイリアスを使い、長い相対パスを避けます。

## ホットリロード
`bun run dev` を実行するとフロントエンドとバックエンドが同期して動き、Bun が自動で Vite dev サーバーを起動するため TSX 変更は即時リロードされます。ワークフローを調整したい場合は `@guren/server` の `startViteDevServer()` を使って自前で Vite を制御できます。

これらのパターンでページとコンポーネントを構成すれば、React と Inertia だけでミニマムなボイラープレートの SPA 体験を得られます。
