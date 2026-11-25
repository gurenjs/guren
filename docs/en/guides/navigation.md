# Navigation

`defineNavigation()` declares the links of your layout on the server. Each entry names a route and says who may see it. On every page the server sends the layout only the links the current user may see, as a shared prop called `navigation`, so the layout holds no role checks of its own.

## Declaring the entries

```ts
// config/navigation.ts
import { defineNavigation } from '@guren/core'
import { Job } from '@/app/Models/Job'

export default defineNavigation([
  { label: 'Jobs', route: 'jobs.index' },
  { label: 'Post a job', route: 'jobs.create', show: { can: ['create', Job] } },
  { label: 'Dashboard', route: 'dashboard', show: { auth: 'required' } },
])
```

Give the definition to `createApp()` beside your other config definitions (see [Configuration](./configuration.md#config-definitions)):

```ts
// src/app.ts
import navigation from '../config/navigation'

export const app = createApp({
  // ...
  config: [navigation],
})
```

An entry is plain data: a label, a route name and an optional `show`. The route must be a named `GET` route with no path parameter, since a link has nothing to fill one with. One entry per route.

## Who sees an entry

`show` takes up to three conditions, and every one you give must hold:

| Condition | Shows the entry when |
|---|---|
| `auth: 'required'` | a user is signed in |
| `auth: 'guest'` | nobody is signed in |
| `auth: 'any'` | always (the default) |
| `where: { role: 'admin' }` | each field of the user equals the value, compared with `===` |
| `can: ['create', Job]` | the gate allows the ability on the model class |

`auth` and `where` are judged first, so an entry that requires sign-in never asks the gate for a guest. `where` compares strictly: a user whose `teamId` is the string `'1'` does not match `{ teamId: 1 }`, and a guest matches no `where` at all. Use it in an app with no policy to ask.

`can` asks the gate the way `this.authorize('create', Job)` does in a controller, with the bare class and no record (see [Authorization](./authorization.md)). Name an ability whose policy method takes the user alone: the gate calls it with no second argument. A guest is asked with a `null` user, so guard a policy method that reads the user. A check that denies hides the entry; one that throws hides it too, and the server logs the error once per ability and model. So does an ability with no policy bound to the model and no gate of that name: the gate denies it, the entry is hidden for everyone, and nothing is logged.

Each distinct ability and model is asked once per page, and all of them at the same time.

Hiding a link protects nothing. A user can still type the URL, so the route's middleware and the action's `this.authorize()` are what keep a page private.

## Rendering the links

The `navigation` prop holds, for each entry the user may see, its `label`, its `path` and whether it is `current`, and nothing else: ability names, hidden routes and `where` fields never reach the browser. The current entry is the one whose path is the request's, else the longest one that prefixes it by whole segments, so `/jobs` is current on `/jobs/42` and not on `/jobsboard`. `/` is current only on `/`.

```tsx
// resources/js/components/Navigation.tsx
import { Link, usePage } from '@inertiajs/react'
import type { NavigationItem } from '@guren/core'

export function Navigation() {
  const { navigation = [] } = usePage<{ navigation?: NavigationItem[] }>().props
  return (
    <nav>
      {navigation.map((item) => (
        <Link key={item.path} href={item.path} aria-current={item.current ? 'page' : undefined}>
          {item.label}
        </Link>
      ))}
    </nav>
  )
}
```

The prop is lazy. A full visit resolves it, and a partial reload that does not ask for `navigation` skips it, along with its gate checks.

## When an entry is hidden at boot

When the app boots, each entry is linked to its route. An entry whose route is not registered, is not a `GET` or has a path parameter is hidden, and the boot prints a warning naming the entry and the reason. The rest of the navigation still renders: a missing route name would otherwise make every page answer 500.

## Next steps

- [Authorization](./authorization.md): the policies a `can` condition asks
- [Inertia](./inertia.md): shared props and partial reloads
