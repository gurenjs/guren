# Frontend Guide

Guren delivers a single-page application experience by combining Inertia.js with React. Controllers return Inertia responses, and the frontend renders the matching React components located under `resources/js/pages/`.

## Project Structure
- `resources/js/app.tsx`: Bootstraps the Inertia app and registers global providers.
- `resources/js/ssr.tsx`: Exports the server-side renderer consumed by the backend when SSR is enabled.
- `resources/js/pages/`: React components that map to controller responses.
- `resources/js/components/`: Shared UI components (optional but recommended).
- `resources/css/app.css`: Tailwind (or your chosen CSS) entry point.

## Page Components
Page filenames mirror the component names passed to `this.inertia()`:

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

- Point HTML responses at the Vite dev server during development (using `VITE_DEV_SERVER_URL` when available).
- Detect the built client manifest (`public/assets/.vite/manifest.json`) and automatically seed `GUREN_INERTIA_ENTRY`/`GUREN_INERTIA_STYLES` in production.
- Locate the SSR manifest (`public/assets/.vite/ssr-manifest.json`) and set `GUREN_INERTIA_SSR_ENTRY` / `GUREN_INERTIA_SSR_MANIFEST` so Inertia can render on the server.

To produce the required assets run both client and SSR builds:

```bash
bunx vite build && bunx vite build --ssr
```

You can override the default resolver—useful for custom component lookups—by editing `resources/js/ssr.tsx` and passing a different `resolve` function to `renderInertiaServer()`. If you opt out of the helper, you can still set the environment variables manually before calling `configureInertiaAssets`.

## Type Safety
- Share types between backend and frontend by re-exporting the Drizzle-inferred types from models (e.g. `export type PostRecord = typeof posts.$inferSelect`).
- Use module path aliases (configured in `tsconfig.json`) to avoid long relative imports.

## Hot Reloading
Running `bun run dev` keeps the frontend and backend in sync. Changes to TSX files trigger instant reloads thanks to Bun’s dev server.

By structuring your pages and components with these patterns, you get a smooth SPA experience with minimal boilerplate, powered entirely by React and Inertia.
