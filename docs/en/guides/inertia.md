# Inertia Protocol Support

Guren ships its own Inertia server adapter inside `@guren/core`, written against the [Inertia protocol](https://inertiajs.com/the-protocol) as `@inertiajs/react` 3 speaks it. This page is the coverage table: which parts of the protocol the adapter implements, which it leaves out, and where each part is documented. If you arrive from the Laravel, Rails or AdonisJS adapter, read this page first and the [Frontend guide](./frontend.md) second.

## The Shape of an Inertia App in Guren

A controller renders a page by name and hands it props. Page names come from codegen, so a typo in the component path or a missing prop fails at compile time rather than at runtime:

```typescript
import { Controller } from '@guren/core'
import { pages } from '@/.guren/pages.gen'

export class UserController extends Controller {
  async index() {
    return this.inertia(pages.users.Index, {
      users: () => User.all(),
    })
  }
}
```

The page component lives under `resources/js/pages/users/Index.tsx` and declares its `Props`. `bunx guren codegen` extracts that interface and types the controller call against it. The [Frontend guide](./frontend.md) covers the project layout, forms and the type flow.

## Protocol Coverage

| Protocol feature | Status | In Guren |
|---|---|---|
| HTML document with the embedded page object | Supported | The page object is serialized with `<` escaped, so prop data cannot close the `<script>` element. |
| Inertia JSON responses (`X-Inertia`, `Vary`) | Supported | `Vary` lists `Accept`, `X-Inertia` and the three partial-reload headers. |
| Asset versioning (`version`, 409 with `X-Inertia-Location` on a GET mismatch) | Supported | The version comes from the `version` option or `GUREN_INERTIA_VERSION`, which the asset bootstrap sets from the Vite manifest. The 409 is decided before any prop resolves, so a stale client never runs a lazy query. It does not echo `X-Inertia-Version`. |
| Partial reloads (`X-Inertia-Partial-Component`, `-Data`, `-Except`) | Supported | Top-level keys only: `author.name` in the header selects `author`. See [Partial Reloads](./frontend.md#partial-reloads). |
| Lazy props (a function evaluated only when sent) | Supported | Pass `() => value`. The page's `Props` still declares the resolved type. |
| Always props | Supported | `always(value)`. `errors` is shared this way. |
| Deferred props with groups (`deferredProps`) | Supported | `defer(() => value, group)`. See [Deferred Props](./frontend.md#deferred-props). |
| Rescued deferred props (`rescuedProps`) | Not supported | A deferred callback that throws fails the follow-up request. |
| Optional props | Not supported | Use `defer()` where the data can arrive after the first render. |
| Merge, prepend and deep merge props (`mergeProps`, `prependProps`, `deepMergeProps`, `matchPropsOn`) | Not supported | A partial reload replaces the prop. |
| Once props (`onceProps`, `X-Inertia-Except-Once-Props`) | Not supported | |
| Infinite scroll (`scrollProps`) | Not supported | Builds on merge props. |
| Resetting props (`X-Inertia-Reset`) | Not supported | Nothing merges, so there is nothing to reset. |
| History encryption (`encryptHistory`, `clearHistory`) | Not supported | |
| Validation errors in the `errors` prop | Supported | A `ValidationException` on an Inertia request flashes the errors and redirects back with 303; the next render carries one message per field. Works without a session through a cookie. See [Form Validation Errors](./validation.md#form-validation-errors). |
| Error bags (`X-Inertia-Error-Bag`) | Not supported | Errors are one flat object per page. |
| Redirects (303 after a non-GET request) | Supported | `this.redirect()` answers a non-GET request with 303. |
| External redirects (409 with `X-Inertia-Location`) | No helper | Return a `Response` with status 409 and the header yourself. |
| Fragment redirects (`X-Inertia-Redirect`, `preserveFragment`) | Not supported | |
| Shared data | Supported | `shareInertiaProps()` resolves per request and passes through the partial-reload filter. The `sharedProps` page key is not emitted. |
| Flash data in the page object (`flash`) | Not supported | Share a flash value as an `always()` prop instead. |
| CSRF (`XSRF-TOKEN` cookie, `X-XSRF-TOKEN` header) | Supported | See [Inertia.js Integration](./csrf.md#inertiajs-integration). |
| Server-side rendering | Supported, in process | `renderInertiaServer()` runs inside the app rather than as a separate Node server, so the `/render`, `/health` and `/shutdown` contract does not apply. A failed render logs and falls back to client rendering. See [Server-Side Rendering](./frontend.md#server-side-rendering). |
| Prefetching (`Purpose: prefetch`) | Needs nothing from the server | The client feature works as is. |
| Precognition | Not supported | |

Client-side features that need no server support, such as `<WhenVisible>`, `usePrefetch` and the `<Form>` component, work as `@inertiajs/react` documents them.

## Testing

`TestApp` asserts on the page object directly:

```typescript
await app.get('/users').assertInertia('users/Index', { users: [] })
```

The controller mock in `@guren/testing` resolves lazy, always and deferred props through the same rule the runtime uses, so a controller test sees the prop set a browser would receive. See the [Testing guide](./testing.md).

## Beyond the Protocol

These are the parts a reader coming from another adapter will not find there:

- Page ids and `Props` are generated, so `this.inertia()` is checked against the component's declared props, and `ControllerInertiaProps` reads the resolved type back for the page.
- `createTypedLink()` and `createTypedForm()` from `@guren/inertia-client` check route names and params at compile time.
- `bunx guren check` warns when a controller passes `defer()` for a prop the page declares as required.
- Prototype mode serves a page from a fixture before any controller exists. See [Prototype-First](./prototype-first.md).

## Client Frameworks

The scaffold and `@guren/inertia-client` target React. The server adapter does not depend on which Inertia client sends the request, but Guren ships no Vue or Svelte scaffold, SSR entry or typed components.

## Next Steps

- [Frontend](./frontend.md): page components, forms, partial reloads, deferred props and SSR.
- [Validation](./validation.md): how validation errors reach an Inertia form.
- [Testing](./testing.md): `assertInertia()` and the controller mock.
