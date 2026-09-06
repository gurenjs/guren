# Chapter 2: One Request, by Hand

Chapter 1 gave you an app with one page you did not write. This chapter has you write the next one from blank files, in the order the rest of the course uses: a failing test, a route, a controller, a page. Then you specify a second page with a test and hand it to the agent, and you watch the harness load the right rule for the file it is editing.

**What you'll learn:**

- How a request travels from `routes/web.ts` to a controller method to a `Response`
- The difference between a plain response and an Inertia page, and when each is enough
- What `bun run codegen` derives from a page's `Props`, and why `pages.about.Index` is a compile-time name
- How to name a route and link to it with the typed `route()` helper
- How the harness's glob-scoped rules reach the agent only when it edits the files they govern

Start the dev server if you stopped it, and keep it running in its own terminal:

```bash run background
bun run dev
```

## 1. The test first

The page does not exist yet. Say what it should do:

```ts file=tests/AboutController.test.ts
import { beforeAll, describe, it } from 'bun:test'
import { TestApp } from '@guren/testing'
import app from '../src/app.js'

describe('AboutController', () => {
  let http: TestApp

  beforeAll(async () => {
    http = await TestApp.fromApp(app)
  })

  it('serves the about page', async () => {
    const response = await http.get('/about').assertOk()
    await response.assertBodyContains('About Guren Blog')
  })
})
```

```bash run expect-fail
bun test
```

The new test fails with a 404: nothing answers `/about`. The two from chapter 1 still pass. Now make the new one pass, one layer at a time.

## 2. The route

A route maps a method and a path to a controller action. Replace `routes/web.ts`:

```ts file=routes/web.ts
import { Router } from '@guren/core'
import HomeController from '../app/Http/Controllers/HomeController.js'
import AboutController from '../app/Http/Controllers/AboutController.js'

export function registerWebRoutes(router: Router): void {
  router.get('/', [HomeController, 'index'])
  router.get('/about', [AboutController, 'index']).name('about')

  // Health check endpoint for load balancers and uptime monitors
  router.get('/health', (c) => c.json({ status: 'ok' }))
}
```

Two things are new. `[AboutController, 'index']` names a class and a method rather than a function: Guren instantiates the controller per request, so the method can read the request through `this`. And `.name('about')` gives the route a name. URLs change; names are what pages link to.

Run the test again and it fails differently: the import of `AboutController` cannot be resolved, so the app cannot boot. That is `guren check`'s job too, but the test found it first.

## 3. The controller, plain response first

Create `app/Http/Controllers/AboutController.ts`:

```ts file=app/Http/Controllers/AboutController.ts
import { Controller } from '@guren/core'

export default class AboutController extends Controller {
  async index(): Promise<Response> {
    return this.text('About Guren Blog')
  }
}
```

```bash run
bun test
```

Green. A controller action is a method that returns a `Response`; `this.text()` builds a plain one. That is the whole contract, and it is worth seeing once without a page in the way, because everything else in a controller (`this.inertia()`, `this.json()`, `this.redirect()`, the validators you meet in chapter 4) is a different way of building that same `Response`.

Open [http://localhost:3333/about](http://localhost:3333/about). Plain text, as promised.

## 4. Now a page

A plain response is right for a health check or a webhook. A page needs HTML, and in Guren that is an Inertia page: a React component under `resources/js/pages/` that receives its props from the controller. Create it:

```tsx file=resources/js/pages/about/Index.tsx
import { Head, Link } from '@inertiajs/react'

interface Props {
  title: string
  description: string
}

export default function AboutIndex({ title, description }: Props) {
  return (
    <>
      <Head title={title} />
      <main className="min-h-screen bg-g-page font-sans text-g-text">
        <div className="mx-auto max-w-3xl space-y-6 px-6 py-12">
          <h1 className="flex items-center gap-3 text-3xl font-bold text-g-heading">
            <span aria-hidden className="h-7 w-[3px] shrink-0 rounded-full bg-[image:var(--g-tick)]" />
            {title}
          </h1>
          <p className="text-lg text-g-text-2">{description}</p>
          <Link href="/" className="text-sm text-g-accent-text transition hover:underline">
            Back to the front page
          </Link>
        </div>
      </main>
    </>
  )
}
```

The component's `Props` interface is not just for React. Codegen reads it and records that the page named `about/Index` takes a `title` and a `description`, both strings. Regenerate the manifests:

```bash run
bun run codegen
```

`.guren/pages.gen.ts` now has `pages.about.Index`, and `this.inertia()` will refuse any props that do not match. Point the controller at the page:

```ts file=app/Http/Controllers/AboutController.ts
import { Controller } from '@guren/core'
import { pages } from '@/.guren/pages.gen'

export default class AboutController extends Controller {
  async index(): Promise<Response> {
    return this.inertia(pages.about.Index, {
      title: 'About Guren Blog',
      description: 'A blog built chapter by chapter, by hand and by agent.',
    })
  }
}
```

```bash run
bun test
```

Still green, and now for the reason you wanted: the body contains the title because the controller sent it as a prop. Reload `/about` in the browser: the page, rendered on the server first, then taken over by React in the browser. Try removing `description` from the controller and running `bun run typecheck`: the error names the page and the missing prop. Put it back.

Three things to take from this section:

- **The page name is the file path.** `resources/js/pages/about/Index.tsx` is `pages.about.Index`. Rename the file and the name follows after the next codegen, and every controller that used the old name stops compiling.
- **Props are the contract.** The controller sends exactly what the page declares. There is no second place where the shape is written down.
- **Codegen is not a build step you remember to run.** `bun run dev` runs it at startup and watches routes, pages and resources for changes; `bunx guren gate` runs it first. You ran it by hand here to see what it does.

Confirm the whole change and commit it:

```bash run
bunx guren gate
```

```bash run
git add -A
git commit -m "feat: add the about page"
```

## 5. Specify the next slice

A contact page, built the same way. This time you write only the test:

```ts file=tests/ContactController.test.ts
import { beforeAll, describe, it } from 'bun:test'
import { TestApp } from '@guren/testing'
import app from '../src/app.js'

describe('ContactController', () => {
  let http: TestApp

  beforeAll(async () => {
    http = await TestApp.fromApp(app)
  })

  it('serves the contact page', async () => {
    const response = await http.get('/contact').assertOk()
    await response.assertBodyContains('Contact')
    await response.assertBodyContains('hello@guren-blog.test')
  })
})
```

```bash run expect-fail
bun test
```

Red. That test is the specification: whoever builds the page, it is done when this passes.

One thing to know before you hand it over. In the test runner, a page is not rendered to HTML; the response carries the page's name and its props, and `assertBodyContains` searches that. So the test can see anything the controller *sends* and nothing the component merely *writes*. The address has to be a prop. That is not a limitation to work around: it is the test telling you where content belongs, and it is why chapter 1's tagline was a prop too.

## 6. Delegate it

Ask your agent, inside `guren-blog`:

> Add a `/contact` page the way `/about` was built: a `ContactController` with an `index` action that sends `title: 'Contact'` and `email: 'hello@guren-blog.test'` as props, a page at `resources/js/pages/contact/Index.tsx` that shows the title as a heading and the email as a mailto link, and a route named `contact` in `routes/web.ts`. `tests/ContactController.test.ts` already describes it; make it pass.

While it works, watch for the harness lever of this chapter. The agent's context does not hold every rule at once. `.claude/rules/routes-codegen.md` starts like this:

```markdown
---
description: Guren routing & codegen — RouteContractOptions, schema binding, the Zod→ApiRoutes matrix, middleware
globs:
  - "routes/**"
  - "app/Http/Validators/**"
---
```

The `globs` line is the point: the rule is loaded when the agent edits a file under `routes/`, and not before. `controllers-http.md` does the same for `app/Http/**`. So when the agent opens `routes/web.ts`, it is handed the exact shape of `router.get(...)`, the options object, and `.name()`, verified against this version of the framework, at the moment it needs them. It cannot invent a route API from memory because the real one is in front of it. And when it saves the file, the `PostToolUse` hook runs `guren check`, which would report a route pointing at a controller method that does not exist.

**No agent handy?** Three files. (An agent may well start with `bunx guren make:controller Contact`, which writes a controller skeleton that already renders `pages.contact.Index`; chapter 3 is about that habit.)

```ts file=app/Http/Controllers/ContactController.ts fallback
import { Controller } from '@guren/core'
import { pages } from '@/.guren/pages.gen'

export default class ContactController extends Controller {
  async index(): Promise<Response> {
    return this.inertia(pages.contact.Index, {
      title: 'Contact',
      email: 'hello@guren-blog.test',
    })
  }
}
```

```tsx file=resources/js/pages/contact/Index.tsx fallback
import { Head, Link } from '@inertiajs/react'

interface Props {
  title: string
  email: string
}

export default function ContactIndex({ title, email }: Props) {
  return (
    <>
      <Head title={title} />
      <main className="min-h-screen bg-g-page font-sans text-g-text">
        <div className="mx-auto max-w-3xl space-y-6 px-6 py-12">
          <h1 className="flex items-center gap-3 text-3xl font-bold text-g-heading">
            <span aria-hidden className="h-7 w-[3px] shrink-0 rounded-full bg-[image:var(--g-tick)]" />
            {title}
          </h1>
          <p className="text-lg text-g-text-2">
            Write to <a href={`mailto:${email}`} className="text-g-accent-text hover:underline">{email}</a>.
          </p>
          <Link href="/" className="text-sm text-g-accent-text transition hover:underline">
            Back to the front page
          </Link>
        </div>
      </main>
    </>
  )
}
```

```ts file=routes/web.ts fallback
import { Router } from '@guren/core'
import HomeController from '../app/Http/Controllers/HomeController.js'
import AboutController from '../app/Http/Controllers/AboutController.js'
import ContactController from '../app/Http/Controllers/ContactController.js'

export function registerWebRoutes(router: Router): void {
  router.get('/', [HomeController, 'index'])
  router.get('/about', [AboutController, 'index']).name('about')
  router.get('/contact', [ContactController, 'index']).name('contact')

  // Health check endpoint for load balancers and uptime monitors
  router.get('/health', (c) => c.json({ status: 'ok' }))
}
```

Either way, regenerate and run the specification:

```bash run
bun run codegen
```

```bash run
bun test
```

Review before you accept. The rubric:

- `routes/web.ts` has one new line, a `GET /contact` route named `contact`, and its import. Nothing else moved.
- `ContactController` has one action and renders a page; it does not build HTML by hand or return `this.text()`.
- The address is a prop the controller sends, not text the page hard-codes; `resources/js/pages/contact/Index.tsx` declares both props in its `Props` interface.
- `tests/ContactController.test.ts` is unchanged and green, and so is everything else.

```bash run
bunx guren gate
```

```bash run
git add -A
git commit -m "feat: add the contact page"
```

## Where you are

- You have traced one request through every layer and written each layer yourself.
- You know what codegen derives from a page, and that the page name and its props are checked at compile time.
- You have specified a page with a test before it existed, delegated it, and accepted it against a rubric.
- You have seen a rule reach the agent because of the file it opened, not because it was asked.

## Common trip-ups

- **`pages.about.Index` does not exist.** Codegen has not run since the page was created. `bun run codegen`, or let `bun run dev` do it; the dev server regenerates when a page is added while it is running.
- **The test passes but the browser shows the old page.** The dev server rendered it before your last save and Inertia kept the old props. Reload with the cache off, or check the terminal running `bun run dev` for a codegen error.
- **The agent returned `this.text()` with HTML in it.** It works and the test passes, which is why the rubric says what the controller must do, not only what the test checks. Ask it to render the page instead; that is the fix you will make many times in this course.
- **`guren check` warns that a controller has no test.** It looks for `tests/<Name>Controller.test.ts`. You wrote both; if the warning names another controller, that is chapter 3's job.

## Next

[Chapter 3: The Posts Table](./03-the-posts-table.md) adds the first database table, a model, and the two pages that read it, then hands the create form to the agent.
