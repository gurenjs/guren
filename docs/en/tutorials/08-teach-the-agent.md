# Chapter 8: Teach the Agent Your Project

In chapter 7 you sent a prompt that said nothing about authorization and found out what caught the omission: your test, and nothing else. This chapter makes sure it is never that close again. You write the rule the agent reads every time it opens a controller, the procedure it follows when it builds an owned resource, and the brief for a reviewer that checks exactly this. Then you test the harness the way you test code: hand the agent a resource without mentioning any of it, and see whether it does the right thing unprompted.

So far you have used the harness. This chapter you write it.

**What you'll learn:**

- What a rule, a skill and a subagent are, and the one difference between them: *when* each acts
- How to write each so an agent can follow it
- What `guren guidelines` derives on its own, so you write only what it cannot
- How `agent:sync` keeps the framework's files current without touching yours
- How to test a harness

Start the dev server if it is not running:

```bash run background
bun run dev
```

## 1. What the framework already knows

Before you write a rule, see what Guren can derive from the code without being told:

```bash run
bunx guren guidelines -o .claude/rules/project-guidelines.md
```

Open the file. It lists your models and their relationships, your validators, your policies (it found `PostPolicy`), the security rules `audit` enforces, and the steps for a new feature. All of it comes from reading the app, which means it is never out of date after you regenerate it, and it means one thing more: **anything in that file, you do not need to write yourself.** Your rule is for what the code cannot say.

`.claude/rules/` is a directory the harness manages by name: `agent:sync` refreshes the six files the framework ships and leaves every other file alone. `project-guidelines.md` and the file you are about to write are yours.

## 2. The rule

What the code cannot say is *why* `PostPolicy` exists and that every owned record must have one. Create `.claude/rules/ownership.md`:

```md file=.claude/rules/ownership.md
---
description: Owned records — a record with an owner column is changed only through a policy, and every such action has an owner test and an other-user test
globs:
  - "app/Http/Controllers/**"
  - "app/Policies/**"
  - "routes/**"
  - "tests/**"
---

# Owned records

A record that belongs to a user carries the owner's id (`authorId` on posts, `userId` on any new table). For every such model:

1. **A policy exists** in `app/Policies/<Model>Policy.ts` and is registered in `app/Providers/AuthProvider.ts` with `getGate().policy(Model, ModelPolicy)`. Its `update` and `delete` (and any other mutating ability) return `user !== null && user.id === record.<ownerColumn>`.
2. **Every action that changes a record** calls `await this.authorize('<ability>', [Model, record])` before doing anything else. Authentication (`requireAuthenticated`, `this.auth.userOrFail()`) is not authorization; a route inside the `auth` group still needs the policy call.
3. **The owner is set by the server**, never by the request: `Model.forceCreate({ ...validated, userId: user.id })` with `user` from `this.auth.userOrFail()`. The owner column is never in `fillable`.
4. **Every mutating action has two tests**: the owner succeeds, and another signed-in user gets `assertForbidden()`. A guest test (`assertRedirect('/login')`) covers the wall, not the door; write both.

`guren audit` verifies authentication only and stays green when a policy call is missing. The tests in rule 4 are the only check that sees it. Write them before the action.
```

The frontmatter is the mechanism. `globs` names the files this rule applies to; when the agent edits a controller, a policy, a route or a test, the rule is loaded into its context, and when it edits a page it is not. The body is written for a reader who will act on it: numbered, one obligation per item, the exact call to make, and the reason the last line gives, because an agent that knows *why* the audit cannot help is less likely to treat a green audit as permission.

## 3. The skill

A rule says what must be true. A skill says how to get there, and the agent reaches for it when the task matches its description. Create `.claude/skills/owned-resource/SKILL.md`:

```md file=.claude/skills/owned-resource/SKILL.md
---
name: owned-resource
description: Add a resource that belongs to the user who created it (a blogroll link, a comment, a bookmark) with its policy, owner column, and owner/other-user tests. Use when asked for something a signed-in user "owns", "creates", or "manages", or for CRUD on a per-user record.
---

# Owned resource

Follow these steps in order. Do not skip the tests; the audit cannot see a missing policy call.

1. Scaffold the resource, then its policy: `bunx guren add resource <Name> --fields "<fields>"` and `bunx guren make:policy <Name>`.
2. Add the owner column to the table in `db/schema.ts`: `userId: integer('user_id').notNull().references(() => users.id)`. Then `bun run db:make create_<names>` and `bun run db:migrate`. Never `db:reset` to get there.
3. In `app/Models/<Name>.ts`, list only the request fields in `fillable`; never the owner column.
4. In the controller: `store` sets the owner with `forceCreate({ ...data, userId: user.id })` where `user` is `await this.auth.userOrFail<UserRecord>()`; `edit`, `update` and `destroy` resolve the record with route model binding and call `await this.authorize('update' | 'delete', [<Name>, record])` first.
5. Register the policy in `app/Providers/AuthProvider.ts`: `getGate().policy(<Name>, <Name>Policy)`.
6. Routes: `index` and `show` public; `create`, `store`, `edit`, `update`, `destroy` inside `router.middleware('auth').group(...)`, with `bind: { id: <Name> }` on the record routes.
7. Tests in `tests/<Name>Controller.test.ts`: the owner can store and update; another user gets 403 on update and destroy; a guest is redirected to `/login` from the form and from store.
8. `bun run codegen`, `bun test`, `bunx guren gate`.
```

Two things to notice. The `description` is what the agent matches a request against, so it names the shapes of request it should trigger on, in the words a person would use. And step 2 encodes the migration discipline from chapter 6 and step 4 the `forceCreate` rule, so the agent does not have to remember either; it has to follow a list.

## 4. The reviewer

A subagent is an agent with its own brief and its own context, invoked by the main one. `code-review` has a general brief. This one has yours. Create `.claude/agents/ownership-review.md`:

```md file=.claude/agents/ownership-review.md
---
name: ownership-review
description: Reviews uncommitted changes for the owned-records rule — every mutation of an owned record goes through a policy, the owner is set server-side, and the owner/other-user tests exist. Use after any change to a controller, policy, route, or test.
tools: Read, Grep, Glob, Bash
---

# Ownership review

You review one thing: whether the changes in `git diff` (staged and unstaged) respect `.claude/rules/ownership.md`. Read that rule first.

For every controller action in the diff that creates, updates or deletes a record:

1. Does the model have an owner column? If so, is there `await this.authorize(..., [Model, record])` before the write? Name the file and line if it is missing.
2. Is the owner set from `this.auth.userOrFail()` with `forceCreate`, and absent from `fillable`?
3. Is the policy registered in `app/Providers/AuthProvider.ts`?
4. Do `tests/<Name>Controller.test.ts` contain, for that action, an owner test and an `assertForbidden()` test for another user?

Report only findings, as a list of `file:line — what is missing`. If there are none, say so in one line. Do not fix anything; the main agent does that.
```

Three artefacts, three moments. The **rule** acts every time a matching file is opened, without anyone asking. The **skill** acts when a task matches its description, and turns a rule into steps. The **subagent** acts when it is invoked, as a second reader with a narrow brief. You will find most things you want an agent to get right fit one of those three, and knowing which is most of the work.

Check that the framework's files are still the framework's:

```bash run
bunx guren agent:sync --dry-run
```

It reports what it would refresh (nothing, on a current harness) and never mentions the three files you just wrote. That is the claim-by-name rule: the sync owns the names it ships, and `ownership.md`, `owned-resource` and `ownership-review` are not among them.

One more piece of the harness you have not used: `.mcp.json` points your agent at the development MCP endpoint that `bun run dev` mounts. Through it the agent can call `guren_check`, `guren_get_context`, `guren_entity_context` and `guren_gate` as tools rather than shelling out, and `guren_make_feature` to run the generator. Nothing in this course depends on it, but if you see `guren_check` in a transcript rather than `bunx guren check`, that is what it is.

```bash run
git add -A
git commit -m "chore: add the ownership rule, skill, and reviewer to the harness"
```

## 5. Specify a resource, and a harness

A blogroll: links a signed-in user adds and owns. The test says what the resource does, and one test says what the harness must have produced:

```ts file=tests/LinkController.test.ts
import { beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { TestApp } from '@guren/testing'
import app from '../src/app.js'
import { resetDatabase } from '../config/database.js'
import { Link } from '../app/Models/Link.js'
import { User, type UserRecord } from '../app/Models/User.js'

describe('LinkController', () => {
  let http: TestApp
  let ada: UserRecord
  let grace: UserRecord
  let asAda: TestApp
  let asGrace: TestApp

  beforeAll(async () => {
    http = await TestApp.fromApp(app)
  })

  beforeEach(async () => {
    await resetDatabase()
    ada = await User.create({ name: 'Ada', email: 'ada@example.com', password: 'correct horse battery' })
    grace = await User.create({ name: 'Grace', email: 'grace@example.com', password: 'correct horse battery' })
    asAda = await http.actingAs(ada).withCsrf()
    asGrace = await http.actingAs(grace).withCsrf()
  })

  it('has a policy', async () => {
    expect(await Bun.file('app/Policies/LinkPolicy.ts').exists()).toBe(true)
  })

  it('lists links', async () => {
    await Link.forceCreate({ title: 'Guren', url: 'https://guren.dev', userId: ada.id })

    const response = await http.get('/links').assertOk()
    await response.assertBodyContains('https://guren.dev')
  })

  it('sends a guest to the login page instead of the form', async () => {
    await http.get('/links/create').assertRedirect('/login')
  })

  it('stores a link owned by the signed-in user', async () => {
    await asAda.post('/links', { title: 'Bun', url: 'https://bun.sh' }).assertRedirect()

    const link = await Link.where('title', 'Bun').first()
    expect(link).not.toBeNull()
    expect(link?.userId).toBe(ada.id)
  })

  it('updates a link for its owner', async () => {
    const link = await Link.forceCreate({ title: 'Guren', url: 'https://guren.dev', userId: ada.id })

    await asAda.put(`/links/${link.id}`, { title: 'Guren docs', url: 'https://guren.dev/docs' }).assertRedirect()

    expect((await Link.findOrFail(link.id)).title).toBe('Guren docs')
  })

  it('refuses to update a link for anyone else', async () => {
    const link = await Link.forceCreate({ title: 'Guren', url: 'https://guren.dev', userId: ada.id })

    await asGrace.put(`/links/${link.id}`, { title: 'Hijacked', url: 'https://example.com' }).assertForbidden()

    expect((await Link.findOrFail(link.id)).title).toBe('Guren')
  })

  it('refuses to delete a link for anyone else', async () => {
    const link = await Link.forceCreate({ title: 'Guren', url: 'https://guren.dev', userId: ada.id })

    await asGrace.delete(`/links/${link.id}`).assertForbidden()

    expect(await Link.find(link.id)).not.toBeNull()
  })
})
```

```bash run expect-fail
bun test
```

The whole file fails to load: there is no `Link` model. Red enough.

## 6. Delegate it, and say nothing

The prompt, deliberately bare:

> Add a blogroll: a Link resource with a title and a URL that a signed-in user creates and owns. Full CRUD at `/links`. `tests/LinkController.test.ts` describes it; make it pass.

No policy, no owner column, no tests are mentioned. Now watch what reads the prompt before the agent acts on it. "Creates and owns" should match the `owned-resource` skill's description; if it does, the transcript shows the agent reading `SKILL.md` and then working down the list. When it opens the controller, `ownership.md` loads on the glob. When it says it is done, ask:

> Use the ownership-review subagent to review the uncommitted changes.

and read its list. The outcomes to distinguish:

- **The skill triggered, the policy call is there, the tests are there.** The harness did the work. In chapter 7 the same omission was caught only by a test you had written by hand; this time the rule and the skill got there first, and the test confirmed rather than rescued.
- **The skill did not trigger, but the rule did.** The agent built the resource its own way and still added the `authorize` calls, because the rule was in its context when it wrote the controller. Rewrite the skill's `description` with the words your prompt used; that is the tuning knob.
- **Neither.** The reviewer's list is non-empty, or the 403 tests are red. Your test caught it, again. Before fixing the code, fix the harness: which of the three did not reach the agent, and why? That is a bug in the rule file, not in the model.

**No agent handy?** Two generators do most of it; the owner column and the wiring are yours:

```bash run fallback
bunx guren add resource Link --fields "title:string,url:string"
```

```bash run fallback
bunx guren make:policy Link
```

```ts file=db/schema.ts fallback
import { sqliteTable, integer, text } from '@guren/orm/drizzle/sqlite'

export const users = sqliteTable('users', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  rememberToken: text('remember_token'),
  createdAt: text('created_at').notNull().$defaultFn(() => new Date().toISOString()),
})

export const posts = sqliteTable('posts', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  title: text('title').notNull(),
  body: text('body').notNull(),
  authorId: integer('author_id').notNull().references(() => users.id),
  publishedAt: text('published_at'),
  createdAt: text('created_at').notNull().$defaultFn(() => new Date().toISOString()),
})

export const links = sqliteTable('links', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  title: text('title').notNull(),
  url: text('url').notNull(),
  userId: integer('user_id').notNull().references(() => users.id),
  createdAt: text('created_at').notNull().$defaultFn(() => new Date().toISOString()),
})
```

```bash run fallback
bun run db:make create_links
```

```bash run fallback
bun run db:migrate
```

```ts file=app/Models/Link.ts fallback
import { defineModel } from '@guren/core'
import { links } from '../../db/schema.js'

export type LinkRecord = typeof links.$inferSelect
export type NewLinkRecord = typeof links.$inferInsert

export class Link extends defineModel(links, { fillable: ['title', 'url'] }) {
}
```

```ts file=app/Http/Controllers/LinkController.ts fallback
import { Controller, paginate, type PaginatedPageProps } from '@guren/core'
import { pages } from '@/.guren/pages.gen'
import { Link } from '../../Models/Link.js'
import type { UserRecord } from '../../Models/User.js'
import { LinkResource, type LinkResourceData } from '../Resources/LinkResource.js'
import { LinkPayloadSchema, ListLinksQuerySchema } from '../Validators/LinkValidator.js'

type LinksIndexProps = PaginatedPageProps<LinkResourceData>

export default class LinkController extends Controller {
  async index(): Promise<Response> {
    const { page } = this.validateQuery(ListLinksQuerySchema)
    const result = await Link.paginate({ page, perPage: 10, orderBy: ['id', 'desc'] })
    const paginator = paginate(result, { path: this.request.path ?? '/links' })

    return this.inertia(pages.links.Index, {
      data: result.data.map((link) => new LinkResource(link).toJSON()),
      pagination: {
        meta: paginator.meta(),
        links: paginator.links(),
      },
    } satisfies LinksIndexProps)
  }

  async show(): Promise<Response> {
    const link = this.model(Link)

    return this.inertia(pages.links.Show, {
      link: new LinkResource(link).toJSON(),
    })
  }

  async create(): Promise<Response> {
    return this.inertia(pages.links.New, {})
  }

  async store(): Promise<Response> {
    const user = await this.auth.userOrFail<UserRecord>()
    const data = await this.validateBody(LinkPayloadSchema)
    const link = await Link.forceCreate({ ...data, userId: user.id })
    return this.redirect(`/links/${link.id}`)
  }

  async edit(): Promise<Response> {
    const link = this.model(Link)
    await this.authorize('update', [Link, link])

    return this.inertia(pages.links.Edit, {
      link: new LinkResource(link).toJSON(),
      errors: {},
    })
  }

  async update(): Promise<Response> {
    const link = this.model(Link)
    await this.authorize('update', [Link, link])
    const data = await this.validateBody(LinkPayloadSchema)
    await Link.update({ id: link.id }, data)
    return this.redirect(`/links/${link.id}`)
  }

  async destroy(): Promise<Response> {
    const link = this.model(Link)
    await this.authorize('delete', [Link, link])
    await Link.delete({ id: link.id })
    return this.redirect('/links')
  }
}
```

```ts file=app/Providers/AuthProvider.ts fallback
import { ServiceProvider, shareInertiaProps, getGate, AUTH_CONTEXT_KEY } from '@guren/core'
import type { AuthContext, AuthManager } from '@guren/core'
import { User } from '../Models/User.js'
import { Post } from '../Models/Post.js'
import { Link } from '../Models/Link.js'
import { PostPolicy } from '../Policies/PostPolicy.js'
import { LinkPolicy } from '../Policies/LinkPolicy.js'

export default class AuthProvider extends ServiceProvider {
  register(): void {
    const auth = this.container.make<AuthManager>('auth')
    auth.useModel(User, {
      usernameColumn: 'email',
      passwordColumn: 'passwordHash',
      rememberTokenColumn: 'rememberToken',
      credentialsPasswordField: 'password',
    })
  }

  boot(): void {
    getGate().policy(Post, PostPolicy)
    getGate().policy(Link, LinkPolicy)

    shareInertiaProps(async (ctx) => {
      const auth = ctx.get(AUTH_CONTEXT_KEY) as AuthContext | undefined
      return { auth: { user: await auth?.user() } }
    }, this.container)
  }
}
```

```ts file=routes/web.ts fallback
import { Router, requireAuthenticated, requireGuest } from '@guren/core'
import HomeController from '../app/Http/Controllers/HomeController.js'
import AboutController from '../app/Http/Controllers/AboutController.js'
import ContactController from '../app/Http/Controllers/ContactController.js'
import PostController from '../app/Http/Controllers/PostController.js'
import LinkController from '../app/Http/Controllers/LinkController.js'
import RegisterController from '../app/Http/Controllers/Auth/RegisterController.js'
import LoginController from '../app/Http/Controllers/Auth/LoginController.js'
import ProfileController from '../app/Http/Controllers/ProfileController.js'
import { Post } from '../app/Models/Post.js'
import { Link } from '../app/Models/Link.js'
import { PostPayloadSchema } from '../app/Http/Validators/PostValidator.js'
import { LinkPayloadSchema } from '../app/Http/Validators/LinkValidator.js'
import { RegisterSchema } from '../app/Http/Validators/RegisterValidator.js'
import { LoginSchema } from '../app/Http/Validators/LoginValidator.js'

export function registerWebRoutes(baseRouter: Router): void {
  // aliasMiddleware() returns a Router carrying the alias name in its type;
  // capture it, or `.middleware('auth')` below will not compile.
  const router = baseRouter
    .aliasMiddleware('auth', requireAuthenticated({ redirectTo: '/login' }))
    .aliasMiddleware('guest', requireGuest({ redirectTo: '/' }))

  router.get('/', [HomeController, 'index'])
  router.get('/about', [AboutController, 'index']).name('about')
  router.get('/contact', [ContactController, 'index']).name('contact')

  router.middleware('guest').group((guest) => {
    guest.get('/register', [RegisterController, 'show']).name('register')
    guest.post('/register', { name: 'register.store', body: RegisterSchema }, [RegisterController, 'store'])
    guest.get('/login', [LoginController, 'show']).name('login')
    guest.post('/login', { name: 'login.store', body: LoginSchema }, [LoginController, 'store'])
  })

  router.middleware('auth').group((auth) => {
    auth.post('/logout', [LoginController, 'destroy']).name('logout')
    auth.get('/profile', [ProfileController, 'show']).name('profile')
    auth.get('/posts/create', [PostController, 'create']).name('posts.create')
    auth.get('/posts/:id/edit', { bind: { id: Post }, name: 'posts.edit' }, [PostController, 'edit'])
    auth.post('/posts', { name: 'posts.store', body: PostPayloadSchema }, [PostController, 'store'])
    auth.put('/posts/:id', { bind: { id: Post }, name: 'posts.update', body: PostPayloadSchema }, [PostController, 'update'])
    auth.delete('/posts/:id', { bind: { id: Post }, name: 'posts.destroy' }, [PostController, 'destroy'])
    auth.post('/posts/:id/publish', { bind: { id: Post }, name: 'posts.publish' }, [PostController, 'publish'])
    auth.post('/posts/:id/unpublish', { bind: { id: Post }, name: 'posts.unpublish' }, [PostController, 'unpublish'])
    auth.get('/links/create', [LinkController, 'create']).name('links.create')
    auth.get('/links/:id/edit', { bind: { id: Link }, name: 'links.edit' }, [LinkController, 'edit'])
    auth.post('/links', { name: 'links.store', body: LinkPayloadSchema }, [LinkController, 'store'])
    auth.put('/links/:id', { bind: { id: Link }, name: 'links.update', body: LinkPayloadSchema }, [LinkController, 'update'])
    auth.delete('/links/:id', { bind: { id: Link }, name: 'links.destroy' }, [LinkController, 'destroy'])
  })

  router.get('/posts', [PostController, 'index']).name('posts.index')
  router.get('/posts/:id', { bind: { id: Post }, name: 'posts.show' }, [PostController, 'show'])
  router.get('/links', [LinkController, 'index']).name('links.index')
  router.get('/links/:id', { bind: { id: Link }, name: 'links.show' }, [LinkController, 'show'])

  // Health check endpoint for load balancers and uptime monitors
  router.get('/health', (c) => c.json({ status: 'ok' }))
}
```

`make:policy` writes a policy that already compares `user.id` with `userId`, so it stands as written. The four pages `add resource` wrote under `resources/js/pages/links/` stand too.

```bash run
bun run codegen
```

```bash run
bun test
```

The rubric is the rule, applied:

- `LinkPolicy` exists and is registered; `edit`, `update` and `destroy` call `authorize` with `[Link, link]`.
- `store` sets `userId` from the session with `forceCreate`; `fillable` is `title` and `url`.
- The record routes carry `bind`, and the mutating ones are in the `auth` group.
- A migration created `links`, and nothing reset the database.
- The seven tests are green, and the `ownership-review` subagent's list is empty.

**Checkpoint:** [http://localhost:3333/links](http://localhost:3333/links). Add one. Sign in as someone else: no edit for you.

```bash run
bunx guren gate
```

```bash run
git add -A
git commit -m "feat: add the blogroll"
```

## Where you are

- A rule the agent reads whenever it edits a controller, a policy, a route or a test; a skill it follows for owned resources; a reviewer with a brief of one paragraph.
- A generated guidelines file that says what the framework can see, so your rule says only what it cannot.
- A resource the agent built with a bare prompt, and evidence of which part of the harness made it right.
- The habit this course has been building toward: when the agent gets something wrong, fix the harness before you fix the code.

## Common trip-ups

- **The skill never triggers.** Its `description` does not contain the words the request used. Descriptions are matched against the prompt; write them in the requester's vocabulary, not the implementer's.
- **The rule loads for pages too.** A glob like `app/**` is wider than the rule's subject. Narrow the globs to the files where the obligation applies, or the rule becomes noise the agent learns to skim.
- **`agent:sync` overwrote my rule.** It only touches the names it ships. If a file of yours was replaced, its name collided with a framework file; rename yours.
- **The `has a policy` test passes but the 403 tests fail.** A policy file exists and nobody calls it. That is the exact gap `ownership-review` is briefed to find; run it.
- **The reviewer reports findings in files the diff did not touch.** Its brief says `git diff`; if it read the whole app, tighten the brief. A subagent does what its file says, no more and no less.

## Next

[Chapter 9: Relationships](./09-relationships.md) replaces the hand-rolled author lookup with `belongsTo` and `hasMany`, adds comments, and hands the agent a many-to-many: tags.
