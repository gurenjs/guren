# Frontend Guide

Guren delivers a single-page application experience by combining Inertia.js with React. Controllers return Inertia responses, and the frontend renders the matching React components located under `resources/js/pages/`.

## Project Structure
- `resources/js/app.tsx`: Bootstraps the Inertia app and registers global providers.
- `resources/js/ssr.tsx`: Exports the server-side renderer consumed by the backend when SSR is enabled.
- `resources/js/pages/`: React components that map to controller responses.
- `resources/js/components/`: Shared UI components (optional but recommended).
- `resources/css/app.css`: Tailwind (or your chosen CSS) entry point.

## Page Components
Page filenames map to the page definitions auto-generated in `.guren/pages.gen.ts`. Props are defined as `interface Props` in each page component and extracted by codegen:

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
import { pages } from '../../../.guren/pages.gen'

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

Use TypeScript to annotate props so you benefit from compile-time safety.

## Layouts and Shared UI
Wrap pages with layout components to keep navigation and shared UI consistent:

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

## Forms and Navigation
Inertia provides helpers for client-side navigation and form submissions:

- `<Link href="/posts/new">Create Post</Link>` for navigation without a full reload.
- `const form = useForm({ title: '', body: '' })` to manage form state.
- `form.post('/posts')` to submit data.

Handle validation errors by returning them from the controller and reading `form.errors` on the client.

## Assets and Styling
The scaffold ships with Tailwind CSS preconfigured. Edit `resources/css/app.css` or add custom CSS frameworks as needed. If you introduce additional assets (images, fonts), place them under `public/`.

## Server-Side Rendering
Each application ships with a default `resources/js/ssr.tsx` entry that calls `renderInertiaServer()` from `@guren/inertia-client`. When you bootstrap the app with `autoConfigureInertiaAssets(app, { importMeta })`, Guren will:

- Start and manage a Vite dev server automatically during development when `bun run dev` boots the app.
- Use `VITE_DEV_SERVER_URL` only when you explicitly want to point HTML responses at an already-running external Vite dev server.
- Detect the built client manifest (`public/assets/.vite/manifest.json`) and automatically seed `GUREN_INERTIA_ENTRY`/`GUREN_INERTIA_STYLES` in production.
- Locate the SSR manifest (`public/assets/.vite/ssr-manifest.json`) and set `GUREN_INERTIA_SSR_ENTRY` / `GUREN_INERTIA_SSR_MANIFEST` so Inertia can render on the server.

To produce the required assets run the app build, which runs codegen before the Vite client and SSR builds:

```bash
bun run build
```

You can override the default resolver—useful for custom component lookups—by editing `resources/js/ssr.tsx` and passing a different `resolve` function to `renderInertiaServer()`. If you opt out of `autoConfigureInertiaAssets`, make sure you populate the required environment variables before calling `configureInertiaAssets` yourself.

## Type Safety

Guren provides end-to-end type safety between controllers and page components through an automatic codegen pipeline.

### How the Type Flow Works

```
Page component          codegen              Controller
┌──────────────┐    ┌──────────────┐    ┌──────────────────┐
│ interface Props    │ pages.gen.ts │    │ this.inertia(     │
│ {             │ ──►│ PagePropsMap │───►│   pages.posts.Show│
│   post: Post  │    │ PageContract │    │   { post }        │
│ }             │    └──────────────┘    │ ) // type-checked │
└──────────────┘                        └──────────────────┘
```

1. **Define Props in the page component** — each page declares an `interface Props` describing the data it expects:

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

2. **Codegen extracts Props** — running `bun run codegen` (or automatically during `bun run dev`) scans every page component, extracts the `interface Props`, and writes them into `.guren/pages.gen.ts`:

```ts
// .guren/pages.gen.ts (auto-generated)
export interface PagePropsMap {
  'posts/Show': { post: PostResourceData }
}

export const pages = {
  posts: {
    Show: defineGeneratedPage<'posts/Show', PagePropsMap['posts/Show']>(...)
  }
}
```

3. **Controller gets type-checked** — when a controller calls `this.inertia(pages.posts.Show, { ... })`, TypeScript checks the second argument against the `PageContract`'s embedded props type. Missing or mistyped props cause a compile error:

```ts
// app/Http/Controllers/PostController.ts
import { pages } from '@/.guren/pages.gen'

export default class PostController extends Controller {
  async show() {
    const post = await Post.findOrFail(id)
    // ✅ Type-checked: { post } must match Props from Show.tsx
    return this.inertia(pages.posts.Show, { post: new PostResource(post).toJSON() })
  }
}
```

### Using Local Types in Props

Props can reference locally defined types. Codegen automatically collects them:

```tsx
type Author = { id: number; name: string }

interface Props {
  post: { title: string; author: Author }
}
```

Both `Author` and the `Props` body are extracted into `pages.gen.ts`.

### Using Imported Types in Props

Types imported from Resource files or other modules are also tracked:

```tsx
import type { PostResourceData } from '@/Http/Resources/PostResource'

interface Props {
  post: PostResourceData
}
```

Codegen rewrites the import path so `pages.gen.ts` can reference the same type.

### Tips

- Share types between backend and frontend by re-exporting the Drizzle-inferred types from models (e.g. `export type PostRecord = typeof posts.$inferSelect`).
- Use module path aliases (configured in `tsconfig.json`) to avoid long relative imports.
- Run `bun run codegen` after adding or changing Props to keep `pages.gen.ts` up to date.

## Hot Reloading
Running `bun run dev` keeps the frontend and backend in sync—the Bun process automatically launches the Vite dev server, so changes to TSX files trigger instant reloads without extra commands. If you need to customize that workflow, import `startViteDevServer()` from `@guren/core/runtime` and manage the Vite instance yourself.

By structuring your pages and components with these patterns, you get a smooth SPA experience with minimal boilerplate, powered entirely by React and Inertia.
