---
name: auth
description: "Add sign-in and decide who may do what: guren add auth / make:auth, guarding routes, a policy registered on the gate, denyAsNotFound(), and the signed-in and denied tests (\"add login\", \"sign up\", \"Google login\", \"only the owner can edit\", \"admin only\", \"403\", \"hide other users' records\")."
---

# Auth Skill

Authentication says who is calling; authorization says whether they may. A
guarded route with no policy lets every signed-in user edit every record, and a
policy nobody registered denies everyone. Work through the steps in order. API
details live in `__RULES_DIR__/controllers-http.md` (Auth and authorization),
`__RULES_DIR__/testing.md` and `__SKILLS_DIR__/guren-api/SKILL.md` (Authorization).

## 1. Add sign-in (an app without `routes/auth.ts`)

```bash
bunx guren add auth                                     # = make:auth --install; takes only --force
bunx guren make:auth --install --verify                 # plus email verification (not with --minimal)
bunx guren make:auth --install --oauth github,google    # plus provider buttons (github, google, discord)
bunx guren make:auth --install --oauth google --oauth-only   # providers only, no passwords
bunx guren add oauth                                    # the OAuth flow alone, for a controller you write
```

Flags go to `make:auth`, never to `add auth`. `--minimal` is login only;
`--no-session` keeps sessions in process memory (lost on restart). `make:auth`
refuses an API-only app; `add oauth` does not.

It writes the login, registration, reset and profile controllers and pages,
`routes/auth.ts` (wired into `routes/web.ts`), `AuthProvider` (shares
`auth.user` with every page), the `User` model, the `users` columns and a
`sessions` table in `db/schema.ts` with one migration, `config/session.ts`, and
`config/mail.ts`. `--install` adds `auth: {}` to `createApp()`, which mounts the
session and CSRF middleware. Then:

```bash
bunx guren db:migrate     # if the scaffold printed a db:make hint instead, run bun run db:make first
bunx guren db:seed        # demo@example.com / secret
bunx guren codegen
```

With `--oauth`, fill the three `OAUTH_<PROVIDER>_*` keys in `.env`; a provider missing one stays unregistered.

## 2. Require a signed-in user

```typescript
import { Router, requireAuthenticated, requireGuest } from '@guren/core'

export function registerWebRoutes(baseRouter: Router): void {
  const router = baseRouter
    .aliasMiddleware('auth', requireAuthenticated({ redirectTo: '/login' }))   // capture the return value
    .aliasMiddleware('guest', requireGuest({ redirectTo: '/dashboard' }))

  router.middleware('auth').group((auth) => {
    auth.post('/posts', [PostController, 'store'])
  })
}
```

In the action, `const user = await this.auth.userOrFail<UserRecord>()` (401 when
signed out). The server picks the owner: `Post.create(data, { set: { authorId: user.id } })`.
`set` needs the model to declare `fillable` (the columns a request may write);
a model with none, as `make:feature` generates it, throws `MassAssignmentException`.
Never put `authorId` or `passwordHash` in `fillable` or in a body schema.
`this.auth.user()` is already stripped of the hash, but send a Resource or
`User.serialize(user)` to a page, never the raw record.

## 3. Decide who may: a policy, end to end

1. `bunx guren make:policy Post` writes `app/Policies/PostPolicy.ts`. As
   generated, `viewAny`, `view` and `create` allow any signed-in user, and
   `update`/`delete` compare `user.id === post.userId` through a local
   `PostLike { userId? }`. Replace `PostLike` with the model's record type and
   `userId` with the real owner column, or the owner is denied too. The blog
   starter's policy compares `Number(user.id) === post.authorId`. For records
   anyone may read, return `true` from `viewAny` and `view`.
2. Register it in a provider's `boot()` (the gate does not exist during
   `register()`). A new provider comes from `bunx guren make:provider Authorization`:

   ```typescript
   import { ServiceProvider } from '@guren/core'
   import { Post } from '../Models/Post.js'
   import { PostPolicy } from '../Policies/PostPolicy.js'

   export default class AuthorizationProvider extends ServiceProvider {
     register(): void {}   // abstract: declare it even when empty
     boot(): void {
       this.container.make('gate').policy(Post, PostPolicy)
     }
   }
   ```

3. List it in `createApp({ providers: [AuthProvider, AuthorizationProvider] })`
   in `src/app.ts`. The scaffolded app does not discover `app/Providers/`.
4. Ask in every action that touches one record, after loading it:

   ```typescript
   const post = await Post.findOrFail(id)
   await this.authorize('update', [Post, post])   // edit, update; 'delete' in destroy; 'view' in show
   await this.authorize('create', Post)           // no record: the bare class
   const canEdit = await this.can('update', [Post, post])   // boolean for the page, no throw
   ```

   Always pass `[Post, post]`: a plain record resolves no policy.
   `make:feature --policy` writes the policy and guards `store`, `update` and
   `destroy`, but leaves `edit` and `show` unguarded, sets no owner column in
   `store`, and registers nothing: do steps 1 to 3 and the missing calls yourself.

### Hide records instead of refusing them

A 403 on `/posts/7` tells a stranger that post 7 exists. Return
`this.denyAsNotFound()` from the ability, and `authorize()` throws a 404 that
reads like a missing record in production, where both say `Not Found` (in
development a missing record's message still names the model and id).
`can()` returns `false`:

```typescript
import { Policy, type AuthUser, type AuthorizationResponse } from '@guren/core'

view(user: AuthUser | null, post: PostRecord): boolean | AuthorizationResponse {
  return post.published || Number(user?.id) === post.authorId ? true : this.denyAsNotFound()
}
```

Widen the stub's `: boolean` as shown, and call `authorize('view', [Post, post])`
in `show`, or the policy never runs. Leave the message empty: a message you pass
is shown as written. It hides one record, not a list: scope `index` with
`Post.where({ authorId: user.id })`.

### Admin only

Not tied to a model: define an ability in the same `boot()`, then guard the route.

```typescript
// AuthorizationProvider.boot()
const gate = this.container.make('gate')
gate.define('access-admin', (user) => (user as { isAdmin?: boolean } | null)?.isAdmin === true)

// routes/web.ts, inside the 'auth' group (authorizeMiddleware from '@guren/core')
auth.get('/admin', [AdminController, 'index'], authorizeMiddleware('access-admin'))
```

`AuthUser` declares only `id`, hence the cast; add the column to `users`.

## 4. What the checks report

`bunx guren audit` (add `--json` for keys):

| Key | Fix |
|-----|-----|
| `authz:<METHOD> <path>` "has no authentication check" | Put the route in the `auth` group or call `this.auth.userOrFail()` |
| `authz:…` "chain authorizes … but requires no authentication" | Put `requireAuthenticated()` ahead of `authorizeMiddleware()` |
| `policy:<METHOD> <path>` | `this.authorize('<ability>', [Model, record])` in the action, edit forms included |
| `owner-fillable:<Model>` | Remove the owner column from `fillable` and the schema; set it with `{ set }` |
| `mass-assignment:<Model>` | Add a `fillable` allowlist |
| `exposure-sensitive-column:…` | Send a Resource or `User.serialize(user)` |

`policy:` is advisory and pairs `app/Policies/<Model>Policy.ts` with the model by
file name, never reading `gate.policy()`: a clean audit does not prove the policy
is registered. When a helper the action calls authorizes, say so in a
`// guren-audit-ignore` comment above the action. `bunx guren check` judges
authorization only on `.agent()` routes (`agent-route-authorization:…`); for
everything else the tests below are the proof.

## 5. Test both sides

Wrap `src/app.ts` with `TestApp.fromApp(app)` as `__RULES_DIR__/testing.md`
shows; prime CSRF after `actingAs()`, or a 403 means nothing.

```typescript
const owner = await User.create({ name: 'Owner', email: 'owner@example.com', password: 'secret' })
const other = await User.create({ name: 'Other', email: 'other@example.com', password: 'secret' })
const post = await Post.create({ title: 'Hi', body: '…' }, { set: { authorId: owner.id } })

await (await http.actingAs(owner).withCsrf()).put(`/posts/${post.id}`, { title: 'New', body: '…' }).assertRedirect()
await (await http.actingAs(other).withCsrf()).put(`/posts/${post.id}`, { title: 'New', body: '…' }).assertForbidden()   // assertNotFound() where the ability returns denyAsNotFound()
await http.get(`/posts/${post.id}/edit`).assertRedirect('/login')   // guest behind requireAuthenticated
```

Write the owner's case first: an unregistered policy or a wrong owner column
fails it with a 403, which nothing else reports. A guest reaching `userOrFail()`
with no redirect guard gets `assertUnauthorized()`.

`actingAs()` sends `X-Testing-User`, which the auth middleware honours only
while `GUREN_TESTING` is set, and `TestApp` sets it. Never set `GUREN_TESTING`
in `.env` or a deployed environment, and never read that header in app code.
Finish with `bunx guren gate`.
