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

Once `config/navigation.ts` exists, `guren codegen` writes the route names an entry may use into `.guren/routes.gen.ts`, so a name that is not a parameterless `GET` route fails the type check. A name that two routes share is listed only when both are parameterless `GET` routes. Until codegen has run, any name type-checks, and the boot warning below is what catches one.

Codegen reads the routes file, so it does not see a route that a provider or plugin registers. To link one, add its name to the registry in any file the app's `tsconfig.json` covers:

```ts
declare module '@guren/core' {
  interface GurenNavigationRoutes {
    'billing.portal': true
  }
}

export {}
```

The reverse also slips through: a module under `modules/` that `createApp()` does not mount still has its route names listed. The boot warning hides that entry, and `guren check` reports it (see [Checking the entries](#checking-the-entries)).

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

## Adding an entry from the command line

`guren nav:add` appends an entry to `config/navigation.ts`, and `guren nav:remove` takes one out by its route name:

```bash
bunx guren nav:add "Post a job" --route jobs.create --auth required --can create:Job
bunx guren nav:remove jobs.create
```

`--auth` takes `required`, `guest` or `any`, and `--can` takes `<ability>:<Model>`. The new entry goes last in the list, in the file's own indentation and comma style. A `--can` model is imported from `@/app/Models/<Model>`, and the command refuses when that file does not exist or exports the name as something other than a class (a type, a declaration or a value), since `createApp()` imports `config/navigation.ts` and the app would fail to start. When it cannot tell, as with a re-export or a value built by a call, it writes the entry and warns. Removing an entry also removes the model's import once nothing else in the file names it.

Both commands read the file the way `guren check` does and refuse one written in a form they cannot read back, such as a spread or a translated label. Each edit holds a lock (`.guren/locks/navigation.lock`) from the read to the write, so two commands run at once both land. It is read back before it is written, and an edit that would not read back as the entries before plus or minus one writes nothing. Neither command checks the route itself; `guren check` does. They refuse when `config/navigation.ts` does not exist; `guren add auth` writes one together with the layout that renders it.

`guren make:feature` and `guren add resource` add the index page's entry through the same writer, labelled with the collection (`Posts`, linking to `posts.index`). An app without `config/navigation.ts` gets no entry. A module's feature gets one too, since a module prefixes its paths and not its route names.

With `make:feature --policy`, the entry also carries `can: ['viewAny', Post]`, so the gate decides who sees it. The index action itself does not ask the policy, so a user it hides the link from can still open the page by its URL. Until the policy is registered, the gate denies `viewAny` and the entry stays hidden, unless a `gate.before()` callback or a gate defined for `viewAny` answers first. The entry imports the model, which imports its table from `db/schema.ts`, so the entry is added only once the schema exports that table; before that, an import the schema cannot satisfy would stop the app from starting, and the command prints the `nav:add --can` line to run once the table is in. A module's feature with `--policy` gets no entry either, since a module's model cannot be a `can` model yet: the command prints a `nav:add` line that adds the entry with no `can`.

`add resource` adds the entry only when the index route carries its name: when `routes/web.ts` already answered `/posts` and the command left it as it was, it prints the `nav:add` line instead. When the file already lists the route, either command says so, and `make:feature --policy` warns when the entry it holds has no `viewAny`. A file it cannot read back or write gets a warning. Either way the feature's files are written.

When `resources/js/components/Layout.tsx` takes props the pages can pass, as the one `guren add auth` writes does, the four pages `make:feature` writes render inside `<Layout>`, and the index page passes `wide`. The props are those of its default export function: `children`, an optional boolean `wide`, and nothing else required. Any other layout is left alone, and the pages keep their own `<main>`.

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

## The layout `guren add auth` writes

`guren add auth` writes `config/navigation.ts` with a Home entry and a Dashboard entry shown only to signed-in users, and adds it to the `config` array of `createApp()`. The Home entry needs a parameterless `GET` route named `home`, which the starter's `/` route is; when the routes file registers none, the file lists Dashboard alone. An existing `config/navigation.ts` is kept, `--force` included, and still added to the `config` array when it is a `defineNavigation()` definition.

The layout it writes, `resources/js/components/Layout.tsx`, renders the `navigation` prop and marks the current entry with `aria-current`. It keeps the account controls, which no entry can hold: Sign in for a guest, and for a signed-in user a link to `/profile` labelled with their name and Log out, which is a `POST`. Their labels come from `lang/en/layout.json`, which `guren add auth` writes once and never replaces.

The brand at the left of the header shows the application's name and links to the first entry the user sees, or to `/` when they see none. The name is the `app` shared prop, which the server sends on every page once `config/env.ts` declares `APP_NAME`. An app that shares its own `app` prop, through `createApp({ inertia: { share } })` or `shareInertiaProps()`, keeps its value.

A page chooses its width. Every page keeps the narrow measure, sized for a form, unless it passes `wide` for a table or a board:

```tsx
import Layout from '../../components/Layout.js'

export default function JobsIndex() {
  return (
    <Layout wide>
      {/* ... */}
    </Layout>
  )
}
```

The header keeps one measure on every page, so it does not move from one visit to the next.

## Adding the module to an existing app

An app that ran `guren add auth` before the navigation module existed has neither `config/navigation.ts` nor a layout that renders the `navigation` prop. `guren add navigation` adds both:

```bash
bunx guren add navigation
```

It writes `config/navigation.ts` when the app has none, with the Home and Dashboard entries `guren add auth` writes, each only when a parameterless `GET` route carries its name (`home`, `dashboard`), and adds it to the `config` array of `createApp()`. An existing `config/navigation.ts` is kept, and still wired when it is a `defineNavigation()` definition.

The layout is replaced only when `resources/js/components/Layout.tsx` is still, byte for byte, a version an earlier `guren add auth` wrote. The command knows every version a release shipped by its hash, as `guren upgrade` knows the UI components. `lang/en/layout.json` is written beside it when absent. A layout you have edited is left as it is, and so is the blog starter's, which `create-guren-app` writes with the app's name in it. The command then prints the lines that render the prop. An app with no layout gets the same lines rather than a layout, since the one `guren add auth` writes links to `/login`, `/profile` and `/logout`.

## When an entry is hidden at boot

When the app boots, each entry is linked to its route. An entry whose route is not registered, is not a `GET` or has a path parameter is hidden, and the boot prints a warning naming the entry and the reason. The rest of the navigation still renders: a missing route name would otherwise make every page answer 500.

## Checking the entries

`guren check` reads `config/navigation.ts` by its syntax, without running it, and judges each entry against the app as it registers (the introspected app, so a provider's routes count). Every result is advisory, so `guren check --ci` and `guren gate` do not fail on them.

| Key | Reported when |
|---|---|
| `navigation-route:<route>` | the route is not registered, is not a `GET` or has a path parameter (the three the boot hides), or two routes share the name |
| `navigation-page:<route>` | the route's action makes no `this.inertia()` call, so the link leads to no page |
| `navigation-sign-in:<route>` | the entry is shown to guests (no `auth: 'required'`, `where` or `can`) and the route's middleware requires sign-in |
| `navigation-ability:<route>` | the action calls `this.authorize()` with a literal ability and the bare model class, on a policy method that takes the user alone, and the entry does not name that ability in `can`, names another one, or names one of two the action authorizes |
| `navigation-can:<route>` | the `can` model has no policy, the policy has no such ability (a `definePolicy()` policy given no callback for it denies everyone), or the ability's method requires a second parameter |

Write the file as plain data for the check to read it: a label and a route as strings, `where` values as literals, and the `can` model as a class imported from its own file. A spread, a computed key or a translated label makes the whole file unreadable, and the check says so on one line. What it cannot follow is reported as unverified rather than passed: an inline handler, a helper the action calls, an ability that is not a string written in place, a model imported through a barrel, a model name two app roots share, or a policy whose `before()` may answer first. A prototype route passes without its fixture entry being read. When the app cannot be introspected, the routes come from the routes file, and one `navigation-routes-unverified` line names the entries whose mounting, and sign-in for those shown to guests, that leaves unknown.

A model's policy is the one in `app/Policies/<Model>Policy.ts`, the file `guren audit` pairs it by. A policy registered under another name through `gate.policy()` is not read, so keep the file name `make:policy` writes.

## Next steps

- [Authorization](./authorization.md): the policies a `can` condition asks
- [Inertia](./inertia.md): shared props and partial reloads
