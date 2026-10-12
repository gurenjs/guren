# Generating Code and Tests from a Plan

`plan:next` sends `scaffold` and `tests` steps to `plan:scaffold`, which writes code and test skeletons from an approved plan. This page describes what it writes, what it leaves for you, and when it refuses. The workflow around it is in [Implementation Plans](./implementation-plans.md), and element states such as `planned` and `wired` are defined in [Reading progress](./implementation-plans.md#reading-progress-planstatus).

## The scaffold step: `plan:scaffold`

A task that adds its own model starts with a `scaffold` step, and `plan:next` names the command that writes it:

```text
Next: task/entity/model.comment/scaffold
  task: entity Comment (task/entity/model.comment)
  verify: codegen → typecheck

Write this step with `bunx guren plan:scaffold docs/plans/comments/plan.json --step task/entity/model.comment/scaffold`, not by hand.
  It writes each added model (table and class), its validators and resources, each policy with a provider registering it, each added controller with its actions as stubs, the routes to them in a file of their own that the http step mounts, and the side-effect classes: model.comment, column.comment.id, column.comment.body, column.comment.postId, column.comment.createdAt, validator.comment, controller.comments, action.comments.store, action.comments.destroy, route.comments.store, route.comments.destroy, resource.comment, policy.comment
```

```bash
bunx guren plan:scaffold docs/plans/comments/plan.json --step task/entity/model.comment/scaffold
```

It appends each added model's table to `db/schema.ts` in the schema's dialect. The table carries every option the plan states for a column (type, nullability, `unique`, `index`, `default`, `columnName`, `withTimezone`, precision and scale, the primary key, the foreign key and its `onDelete`) and the model's multi-column indexes:

```typescript
export const comments = pgTable('comments', {
  id: serial('id').primaryKey(),
  body: text('body').notNull(),
  postId: integer('post_id').notNull().references(() => posts.id, { onDelete: 'cascade' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index('comments_post_id_index').on(table.postId),
])
```

It writes `app/Models/Comment.ts` with the plan's `fillable` and relationships, each keyed by the foreign key the plan states. A relationship whose keys or target do not exist yet is left out and listed, for the step where they exist. When it waits on a later task's work, such as a `hasMany` to a child the next task adds, the list names the step that owns that work (the later task's `data` step, or one of its parts): the relationship is judged there, as a property of the model it waits on, and written in the declaring model's file; `plan:next` lists it under that step. Any other relationship left out makes `plan:status` read the model as `drifted` until it is added.

The step's validators go in one file named after the model, `app/Http/Validators/CommentValidator.ts`, one exported schema per validator. Each field is written from its planned type, `required` and rules (`min`, `max`, `email`, `url`, `uuid`), in the form `plan:status` reads back:

```typescript
import { z } from 'zod'

export const CommentPayloadSchema = z.object({
  body: z.string().min(1).max(2000),
})
```

A validator an action takes its `query` or `params` from gets `z.coerce.number()` and `z.stringbool()` for numbers and booleans, since those values arrive as text. A rule written in prose, or one that does not fit the field's type (a bound on a boolean), is not written, and the report lists it.

Each resource whose model the step adds is written as a `Resource` subclass with the planned payload type, which `guren codegen` reads for `data.gen.ts`. A field is copied from the model's column when the planned type admits every value the column reads back as, a date-time column is serialized with `toISOString()` for a planned `string`, and a JSON column is cast to the planned type. Any other field calls a stub that throws until you map it, and the report lists it:

```typescript
export class CommentResource extends Resource<CommentRecord, CommentResourceData> {
  toArray(): CommentResourceData {
    return {
      id: this.resource.id,
      body: this.resource.body,
      createdAt: this.resource.createdAt.toISOString(),
    }
  }
}
```

Each policy is written with one method per planned ability, and every method returns `false` until you write its rule, which the method's comment quotes. `app/Providers/CommentPolicyProvider.ts` registers it with the authorization gate in `boot()`, and the command adds that provider to `createApp({ providers })` in `src/app.ts`. `plan:status` reads a policy by its abilities and does not read its registration, so a policy is complete at `present`.

Each controller the step adds holds exactly the planned actions and nothing else. An action validates its `params` and `query` with the planned validators, authorizes with the planned policy ability, validates its `body`, then answers 501. A caller the policy denies gets 403 whatever it sent:

```typescript
export default class CommentController extends Controller {
  // Planned response: a redirect to /posts/:postId
  // Rule: The comment's author is the signed-in user.
  // postId is not fillable: write it with Comment.create(data, { set: { postId } }) (RFC 0031)
  async store(): Promise<Response> {
    await this.validateBody(CommentPayloadSchema)
    throw HttpException.notImplemented('CommentController.store is planned and not written yet')
  }

  // Planned response: a redirect to /posts/:postId
  async destroy(): Promise<Response> {
    const comment = this.model(Comment)
    await this.authorize('delete', [Comment, comment])
    throw HttpException.notImplemented('CommentController.destroy is planned and not written yet')
  }
}
```

The ability is asked of a record in the `[Model, record]` form, because an ORM record carries no class the gate could find the policy by. For any ability but `viewAny` and `create`, which a policy asks without a record, where every route to the action binds one record of the policy's model, the stub reads it with `this.model()` and passes the tuple. Otherwise it passes the bare class, and for a record ability (`view`, `update`, `delete` and the like) the comment above the action names the tuple to pass once the action loads the record. An action a `POST` route takes a body to lists, in the same comment, the foreign keys an added model's `fillable` leaves out: `create()` refuses them in its data, so they go through `set` (RFC 0031).

It validates with `validateBody()` rather than `validated('comments.store')`, since `validated()` is typed from the generated route names, and the route is not registered until the `http` step mounts it. No response is written: `plan:status` credits a response it can name (a resource, a page, a redirect), so a stub that named one would read as done. The report lists every action's response as left to write.

The routes to those actions go in a file of their own, `routes/comments.ts`, with each route's method, path, name, contract schemas, bindings, `auth` middleware and `.agent()` metadata as planned:

```typescript
export function registerCommentRoutes(router: Router): void {
  const authRouter = router.aliasMiddleware('auth', requireAuthenticated({ redirectTo: '/login' }))
  authRouter.post('/posts/:postId/comments', { name: 'comments.store', body: CommentPayloadSchema, bind: { postId: Post } }, [CommentController, 'store']).middleware('auth')
  authRouter.delete('/comments/:id', { name: 'comments.destroy', bind: { id: Comment } }, [CommentController, 'destroy']).middleware('auth')
}
```

Nothing calls the file yet, so its routes are not registered and read as `planned`: a mounted route would answer 401 or 422 before the `tests` step, and a behaviour that already passes fails that step. `auth` is the only middleware it applies; any other name the plan gives is listed for the `http` step, which knows the handler the application aliases it to. `guren check` reports the unmounted file as advisory while the plan is approved and not closed and its `http` step is not verified, so `guren gate` does not block the steps in between. Once that step verifies or the plan closes, an unmounted file is a warning again.

Each job, event, listener, mail and notification the step adds is written as the matching `make:*` command writes it, under the plan's class name. `plan:status` reads one as `present`; it is `wired` once something dispatches, registers or sends it, which is the `http` step's work. Where `docs/entities/Comment.md` already exists, the controller and the routes file carry `@docs docs/entities/Comment.md`; a tag to a document that does not exist yet would fail `guren check`.

It runs neither codegen nor a migration: `plan:verify` runs codegen and the typecheck, and the `data` step generates the migration.

Every refusal comes before the first write. It refuses:

- a draft, or a plan no approval names;
- a step other than a `scaffold` or `tests` step (it names the task's own scaffold step), or one `plan:next` has not marked;
- a model, validator, resource, policy, controller or side effect in a module (it writes to the project root only), and an API-only application;
- on MySQL, a key over a `text` or `json` column (a primary key, `unique`, an index, or a foreign key, which MySQL indexes), which drizzle-kit refuses and MySQL rejects without a prefix length (plan the column as `string`, or drop the key), and a `default` of `null`;
- a resource whose name does not end in `Resource`, which `guren codegen` would not discover, a policy ability named after one of `Policy`'s own members (`before`, `allow`, `deny`), and an action named after one of `Controller`'s (`redirect`, `json`);
- a policy provider it cannot register: no `src/app.ts` or `app.ts`, no `createApp()` call it can patch, or one that already registers it;
- any target that already exists: the model file or class, the schema export, the table name in any application root, a file it would create, a validator name another validator file exports, and a resource, policy, controller or side-effect class of the same name.

Running it again on a scaffolded step is refused the same way, since its files exist; verify the step instead. `--json` prints the files it created, the tables it appended, the providers it registered, the routes file it left unmounted and the step that mounts it, the elements it wrote, the ones it left, what it wrote as a stub or not at all, and the relationships it left out.

## Mounting the routes: `plan:scaffold --mount`

The `http` step holding the routes a scaffold wrote starts by mounting them, and `plan:next` names the command:

```text
Mount the routes the scaffold step wrote first, with `bunx guren plan:scaffold docs/plans/comments/plan.json --step task/entity/model.comment/http --mount`, not by hand: it calls routes/comments.ts from the entry registrar.
  Written as stubs by plan:scaffold, to finish: validator.comment, controller.comments, action.comments.store, action.comments.destroy, route.comments.store, route.comments.destroy, resource.comment, policy.comment. Each action validates and authorizes as planned and answers 501; write its body and response.
```

It imports `registerCommentRoutes` into `routes/web.ts` and calls it first in the registrar there. Being first, an `auth` alias the entry sets replaces the one the routes file sets. The mounted routes also register ahead of the entry's own, so a scaffolded path with a parameter, such as `/posts/:id`, can shadow an entry route like `/posts/create`: check the order when the two overlap. `plan:status` then reads the routes and their actions as `wired`, and the validators they use too. What is left is each action's body and response, and what the scaffold listed as a stub or not at all.

It refuses, writing nothing, a draft or a plan no approval names, a step `plan:next` has not marked, a step that holds no scaffolded routes (it names the one that does), a routes file that does not exist or no longer exports its registrar, an application with no `routes/web.ts`, an entry that already imports another binding under the registrar's name, and a file already mounted, whether the entry calls it or another routes file does.

## Test skeletons: `plan:scaffold` on a tests step

The `tests` step is written by the same command. `plan:scaffold <plan> --step <task>/tests` writes one file, `tests/plans/<plan>/<collection>.test.ts` (for the comments plan, `tests/plans/comments/comments.test.ts`), with one `TestApp` test per behaviour of the step:

```ts
test('[AC-comments-1] A signed-in user can comment on a post.', async () => {
  given('a post exists')
  const actor = given<object>('the actor: user')
  const postId = given<number | string>('the :postId parameter')
  await (await client(actor)).post(`/posts/${postId}/comments`, { body: 'Nice post' }).assertStatus(302)
  expect(await Comment.where({ body: 'Nice post' }).first()).not.toBeNull()
})
```

- The title starts with the behaviour's id, which is how `plan:verify` selects the file. A bracket in the plan's prose is written as a parenthesis, so the file carries no other id.
- The request is the one its route names: the method, the path with each parameter as a whole-segment interpolation, and the `input` as the body (as the query string for a `GET`).
- The expectations are the plan's: `status`, `redirect` (a parameter it shares with the route reuses the route's value), `inertia` (the request asks for JSON, which returns the page without Inertia's version check), `errors` (read from the JSON body), and a `database` row as a query through the model, for a table whose model the root declares and a value the plan's column type can compare with. Setting up those rows and cleaning them up is yours: a row another test left behind can make the expectation pass or fail whatever the code does.
- The setup the plan states in prose, the signed-in actor where the route requires one, and each path parameter are `given()` calls, which throw. An expectation the skeleton cannot write is an `unwritten()` call, which throws too, and so is an expected 404, which a route that does not exist yet answers as well. The report and the output list each one.
- `ready()` imports `src/app.ts` and boots it once with `TestApp.fromApp()`. The file's `beforeAll` calls it, so the ORM is configured before any `beforeEach` you add to create or clear rows. It waits up to 120 seconds, past Bun's 5-second hook default. A boot that fails is printed there rather than thrown, so `plan:verify` records the step `blocked` whatever your hooks do, and each test that calls `ready()` or `client()` fails by name with it. Open a hook of your own with `await ready()`, so the boot failure, not a database error, is what each test reports.
- `client()` returns the booted application, acting as the actor when given one, and primes CSRF with `withCsrf()` when the application mounts it; an application that mounts CSRF with `cookie: false` is not handled.
- Only `auth` or `auth:*` middleware, a policy, or a `forbidden` behaviour gets a signed-in actor.

Before the implementation exists every test fails, either at a `given()` call or on the route that is not mounted yet, and none is skipped, so the step verifies as `tests:fail` asks. When the application does not boot, `plan:verify` records the step `blocked`, since no test reached its route. Two cases can pass before any code is written, and `tests:fail` then fails the step: a behaviour on a route that exists already with nothing to set up, which the report lists as may pass now, and a behaviour on a new route whose path an existing route already answers, which nothing lists. Replace each `given()` and `unwritten()` call with the setup or assertion it names. Do not turn a test into `test.skip` or `test.todo`: a skipped case is not a run, and the step fails on it. Keep each title's id and each request, since the later steps run the same file and need it to pass.

It refuses, writing nothing, a draft or a plan no approval names, a step `plan:next` has not marked, a file that already exists (a re-run), a behaviour another test file already carries (`plan:verify` would find it in two files), a request body or expected value holding another behaviour's id, and an application whose `src/app.ts` or `app.ts` has no default export to boot. An API-only application has a `tests` step like any other, and gets its skeletons, although it has no `scaffold` step. A route parameter with a constraint (`:id{[0-9]+}`) is a limit of the static reading: a runtime value may fail the constraint, so the request is read as uncertain rather than as reaching the route.
