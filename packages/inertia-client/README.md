# @guren/inertia-client

The React frontend for [Guren](https://guren.dev/) applications, on [Inertia.js](https://inertiajs.com/): client bootstrap, SSR entry, and links and forms typed against your server routes.

```bash
bun add @guren/inertia-client
```

Scaffolded apps already depend on it, and `resources/js/app.tsx` is generated for you.

## Booting the client

```tsx
// resources/js/app.tsx
import { startInertiaClient } from '@guren/inertia-client'
import { pages, pageManifest } from '@/.guren/pages.gen'

startInertiaClient({ pages, pageManifest })
```

## Typed pages

A page component declares the props it needs. Codegen reads that interface, and the controller's `this.inertia()` call is checked against it, so a renamed prop fails `tsc` instead of rendering `undefined`:

```tsx
// resources/js/pages/posts/Index.tsx
import type { PostResourceData } from '@/app/Http/Resources/PostResource'

interface Props {
  posts: PostResourceData[]
}

export default function Index({ posts }: Props) {
  return <ul>{posts.map((post) => <li key={post.id}>{post.title}</li>)}</ul>
}
```

## Typed links and forms

`createTypedLink()` and `createTypedForm()` take the generated route manifest and check route names and params at compile time:

```tsx
<Link route="posts.show" params={{ id: post.id }}>{post.title}</Link>
```

## Subpath exports

| Import | Contents |
|--------|----------|
| `@guren/inertia-client` | `startInertiaClient()` and the shared client API |
| `@guren/inertia-client/server` | The SSR entry point |
| `@guren/inertia-client/components` | `createTypedLink()`, `createTypedForm()` |
| `@guren/inertia-client/typed-forms` | `RouteBody`, `RouteErrors`, and the form helpers |
| `@guren/inertia-client/channel` | Broadcasting subscriptions from a page |
| `@guren/inertia-client/prototype` | Fixture-backed pages for prototype-first development |

## Documentation

The [frontend guide](https://guren.dev/docs/guides/frontend) covers pages, layouts, forms, and SSR.

## License

MIT
