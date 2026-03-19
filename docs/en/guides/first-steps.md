# First Steps: Hello Guren

This is the shortest path to a working page. It does not use the database. You will add a `/hello` route and page.

## What you will build
- A minimal route -> controller -> React page
- A browser view at `/hello`

## Prerequisites
- A project scaffolded with `bunx create-guren-app`
- `bun install` completed
- `bun run dev` can start

> [!NOTE]
> If any term is unfamiliar, see the [Glossary](./glossary.md). This guide does not require PostgreSQL.

## Expected result
- Visiting `http://localhost:3333/hello` shows `Hello Guren!`

## 1. Create a controller
Create `app/Http/Controllers/HelloController.ts`.

```ts
import { Controller } from '@guren/server'

export default class HelloController extends Controller {
  async index() {
    return this.inertia('Hello', { message: 'Hello Guren!' })
  }
}
```

## 2. Create a page
Create `resources/js/pages/Hello.tsx`.

```tsx
type Props = {
  message: string
}

export default function Hello({ message }: Props) {
  return (
    <main className="mx-auto max-w-xl px-6 py-12">
      <h1 className="text-3xl font-semibold">{message}</h1>
      <p className="mt-3 text-slate-600">
        This is the smallest possible Guren page.
      </p>
    </main>
  )
}
```

## 3. Register the route
Add the route to `routes/web.ts`.

```ts
import HelloController from '@/app/Http/Controllers/HelloController'

Route.get('/hello', [HelloController, 'index'])
```

> [!NOTE]
> `src/main.ts` usually imports `routes/web.ts`. If you customized the bootstrap, make sure the route file is imported.

## 4. Verify in the browser
Start the dev server and open the URL.

```bash
bun run dev
```

Open `http://localhost:3333/hello`. If you see `Hello Guren!`, you are done.

## If you get stuck
- 404: confirm `routes/web.ts` is imported from `src/main.ts`
- No reload: restart `bun run dev`
- Port in use: change `PORT` in `.env` and restart

## Next steps
1. [Routing Guide](./routing.md)
2. [Controller Guide](./controllers.md)
3. [Frontend Guide](./frontend.md)
4. [Database Guide](./database.md)
