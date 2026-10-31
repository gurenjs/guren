# RFC: UI Components and Contract-Derived Form Fields

**Author:** Guren contributors
**Date:** 2026-10-31
**Status:** Draft

> Guren ships design tokens (`resources/css/guren.css`) but no components, so
> every generated page carries its own copy of the input, label, button and
> error markup. This RFC adds `guren add ui`, which copies a small set of
> token-styled React components into the app, and moves `make:feature` and
> `make:auth` onto them. It also adds a form field to `@guren/inertia-client`
> that reads the route's body schema, through a new codegen artifact, to set
> its label, `required`, input `type`, length and range limits, and its error
> message.

## Problem

### Design changes edit every page

A Guren app gets its look from `resources/css/guren.css`: the `--g-*` custom
properties and the Tailwind `g-` utilities mapped onto them in `@theme inline`.
The file is copied into the app by `create-guren-app`, and by
`ensureGurenUiTokens()` in `packages/cli/src/guren-css.ts` when a generator
needs it. Three byte-identical copies are pinned by
`packages/cli/tests/guren-css-sync.test.ts`; upstream is `gurenjs/guren-ui`.

The tokens stop at colours, radii and shadows. How a text input, a label or a
primary button is assembled from them lives in four class strings in
`guren-css.ts`:

```ts
export const FORM_INPUT_CLASS = 'w-full rounded-g-ctl border border-g-line-strong bg-g-panel px-3 py-2 …'
export const FIELD_LABEL_CLASS = 'block text-sm font-bold text-g-heading'
export const PRIMARY_BUTTON_CLASS = 'rounded-g-ctl bg-g-accent px-4 py-2 text-sm font-bold …'
export const PRIMARY_SUBMIT_CLASS = `w-full ${PRIMARY_BUTTON_CLASS} disabled:cursor-not-allowed disabled:opacity-45`
```

`make:feature` and `make:auth` interpolate them into the pages they write. The
strings are shared at generation time and duplicated at run time: the input
class is written once per field on every New and Edit page, and again in each
auth page. Changing the focus ring, or the button's padding, means editing every
page or regenerating it. The same holds for markup that is not a class string
at all: the danger callout `make:auth` builds with `calloutRow()`, the card
markup on index pages, the error paragraph under each field.

### Every field restates its wiring

A field in a `make:feature` New page is fifteen lines of generated JSX
(`generateFormField()`): a `<label htmlFor={fieldIds.title}>`, the control, an
`aria-invalid` and an `aria-describedby` that switch on while
`form.errors.title` is set, and the error paragraph with the matching `id`.
`make:auth` writes the same structure by hand, differently in each page (the
login page reads `errors` from page props, the profile page from
`form.errors`). An accessibility fix to that structure is a fix to two
generators and every page they have already written.

### The page knows nothing the validator knows

The route's body schema already says which fields are required, which are
numbers, which are emails, and how long a title may be. Codegen turns that
schema into a TypeScript type (`ApiRoutes['posts.store']['body']`, read by
`RouteBody` in `typed-forms.ts`), so the page cannot submit a field the
validator does not declare. None of the schema's constraints reach the
rendered form. A generated New page has no `required`, no `maxLength`, no
`type="email"`, and labels each field with its raw identifier (`startsAt`). A
user finds out the title was too long after a round trip, and an author who
adds `.max(120)` to the validator has to remember to add `maxLength={120}` to
the page.

## Proposed Solution

Two features that share one boundary:

1. **`guren add ui`** copies styled, token-only components into
   `resources/js/components/ui/`. The app owns them. Generators import them
   instead of inlining classes.
2. **Contract-derived fields.** `guren codegen` writes `.guren/forms.gen.ts`,
   one plain-data form contract per named route that binds an object body
   schema. `@guren/inertia-client/forms` ships the headless logic that turns a
   contract field into label, control attributes and error state. The copied
   `Field` component renders that logic with the copied `Label`, `Input` and
   friends.

The split follows one rule: **markup and classes are the app's; anything that
reads a generated artifact is the package's.** A design change edits a file the
app owns. A change to the codegen format ships in a package release, with no
re-copy.

### 1. `guren add ui`

```bash
bunx guren add ui                 # every component
bunx guren add ui button field    # only these (and what they import)
bunx guren add ui field --diff    # print an existing copy against the current template; writes nothing
```

It is a blueprint under `add`, beside `add session` and `add browser-tests`,
and is classified as a generator in `PLAN_COMMAND_CLASSES`
(`packages/cli/src/plan/command-allowlist.ts`), so a plan may list it.

**What it writes.** One file per component under
`resources/js/components/ui/`. There is no barrel: a page imports each
component from its own file (`@/resources/js/components/ui/Field`), so
installing one more component never requires editing a file the app already
owns.

| File | Renders | Replaces |
|------|---------|----------|
| `Button.tsx` | `<button>`; `variant: 'primary' \| 'secondary' \| 'danger' \| 'ghost'`, `size: 'md' \| 'sm'`, `block`. Also exports `buttonClass(options)` for an Inertia `<Link>` styled as a button | `PRIMARY_BUTTON_CLASS`, `PRIMARY_SUBMIT_CLASS`, the Delete link on Show pages |
| `Label.tsx` | `<label>` | `FIELD_LABEL_CLASS` |
| `Input.tsx` | `<input>`, every native prop forwarded; `aria-invalid` drives the danger border | `FORM_INPUT_CLASS` |
| `Textarea.tsx` | `<textarea>`, same styling | `FORM_INPUT_CLASS` on textareas |
| `Select.tsx` | native `<select>`; `options?: { value, label }[]` or children | nothing today (plans can name `select`) |
| `Checkbox.tsx` | `<input type="checkbox">` inside its `<label>` | the inline checkbox in `generateFormField()` |
| `Field.tsx` | label, control, hint and error for one form key (section 2.3) | `generateFormField()`'s fifteen lines |
| `Card.tsx` | `<section>` with `rounded-g-card border-g-line bg-g-panel shadow-g-card`, optional `title` | the card markup on index pages |
| `Alert.tsx` | `tone: 'ok' \| 'warn' \| 'danger'`; `role="alert"` for danger, `role="status"` otherwise | `calloutRow()` in `make-auth.ts` |

The components are native elements styled with `g-` utilities and nothing else:
no raw colours, no Radix or other headless dependency, no `className` merging
library. A `className` prop is appended, so a page can add layout classes. The
templates live as real sources under `packages/cli/templates/scaffold/ui/`, so
`typecheck:templates` compiles them and `tests/scaffold-output.test.ts`
parse-gates them, as with the other static scaffold templates.

**Ownership rules.**

- An existing file is never overwritten, by the rule `ensureGurenUiTokens()`
  already follows for `guren.css` (`writeFile(…, { flag: 'wx' })`). A re-run
  writes only what is missing and lists what it left alone.
- `guren.css` is written first if absent, through `ensureGurenUiTokens()`.
- An API-only app is refused through `packages/cli/src/app-surface.ts`, the
  rule the page-emitting scaffolders already share.
- `add ui` checks that the installed `@guren/inertia-client` exports the
  `forms` subpath before writing `Field.tsx`, and names the upgrade otherwise
  (Migration Path).
- Each file opens with a one-line header naming the component and the template
  version it was copied from (`// guren-ui: Field v1`), and saying that
  `guren upgrade` replaces the file only while it is unedited. The header is for
  the reader; the upgrade path below identifies a copy by its content, not by
  the header.

**Upgrading a copy.** `guren upgrade` reaches the token sheet through a doctor
check and its autofix (PR #1246: the `guren-ui-tokens` check, a marked block in
`guren.css`, and `SHIPPED_UNMARKED_SHEETS` for the sheets released before the
markers). The components use the same path, with the one difference that
follows from ownership: a component file is the app's whole, so there is no
block to mark, and a copy is judged by its content alone.

- A new doctor check, `guren-ui-components`, reads each file under
  `resources/js/components/ui/` whose name is a shipped component and hashes
  it (sha256 over LF-normalized bytes).
- The CLI carries, per component, the hashes of every template version it has
  released (`SHIPPED_UI_COMPONENTS`, closed like `SHIPPED_UNMARKED_SHEETS`;
  the current template is hashed at run time, not listed).

| Copy | Check | Upgrade |
|------|-------|---------|
| absent | pass | nothing (creating it stays with `add ui` and the generators) |
| identical to the current template | pass | nothing |
| identical to an earlier released version | warn | the autofix replaces the file with the current template |
| matches no released version (edited) | warn, naming the component and the template version its header claims | nothing; the message points at `guren add ui <name> --diff`, which prints the edited copy against the current template |

Because it is a doctor autofix, `guren upgrade --dry-run` previews it,
`--no-autofix` leaves it as a warning, and the first `guren upgrade` after the
new CLI is installed applies it, exactly as for the token sheet. A component
change that alters the props a generator emits against ships with the template
change in the same release, so an app whose copy is unedited gets both at once,
and an app whose copy is edited is told which file to reconcile.

### 2. Contract-derived fields

#### 2.1 How the schema reaches the client

The client cannot import the validator: validator files may import server-only
modules, and shipping zod to every page for a handful of attributes is the wrong
trade. Codegen already holds the runtime schema. `src/codegen.ts` loads the
registered route definitions once, each carrying `schemas.body` as the Zod
object the route binds, and hands them to each generator;
`generateApiClientTypes()` (`api-client-types.ts`) renders the body as a type
through `schemaToTypeString()`. The same definitions can be rendered as data.
`.guren/agents.gen.ts` is the precedent: its `inputSchema` is a JSON Schema
literal, produced by the walker in `@guren/server/internal/zod-json-schema` and
written with `renderLiteral()`.

`guren codegen` gains one more conditional artifact, `.guren/forms.gen.ts`,
written by a new `packages/cli/src/forms-types.ts`:

```ts
// Generated from routes/web.ts — DO NOT EDIT
import type { RouteFormContract } from '@guren/inertia-client/forms'
import type { ApiRoutes } from './api-client.gen'

export const postsStoreForm: RouteFormContract<'posts.store', 'POST', '/posts', ApiRoutes['posts.store']['body']> = {
  route: 'posts.store',
  method: 'POST',
  path: '/posts',
  fields: {
    title: { type: 'string', required: true, minLength: 1, maxLength: 120 },
    body: { type: 'string', required: true, minLength: 1 },
    published: { type: 'boolean', required: true },
    category: { type: 'string', required: true, enum: ['news', 'howto'] },
    contactEmail: { type: 'string', required: false, nullable: true, format: 'email' },
  },
}

export const postsUpdateForm: RouteFormContract<'posts.update', 'PUT', '/posts/:id', ApiRoutes['posts.update']['body']> = { … }
```

- **Which apps.** Only an app that depends on `@guren/inertia-client`
  (positive evidence, read from `package.json` as `app-surface.ts` reads it).
  An API-only app gets no `forms.gen.ts`, since its `tsconfig.json` includes
  `.guren/**/*` and the import would not resolve. When the last eligible route
  goes, codegen removes the file rather than leaving a stale one.
- **Which routes.** Every named route whose `body` schema is an object.
  `io: 'input'`, because the form describes what the browser sends, the side
  `ApiRoutes.body` already renders. A route with no body schema, or one that is
  not an object, gets no export.
- **One export per route, not one map.** A page imports only the contract it
  submits to, so a bundler drops the rest. The identifier is the route name in
  camel case plus `Form` (`posts.store` → `postsStoreForm`). Two route names
  that camel-case alike fail codegen with both names in the message
  (Open Question 4).
- **Literal method and path.** The contract's type keeps both as literals, so
  `useRouteForm` can require `params` exactly when the path has parameters,
  with the `PathParamsOf` helpers `components.tsx` already mirrors.
- **Every key survives.** `readObjectSchema()` drops a property the walker
  cannot render (`z.file()`, `z.unknown()`), with its requiredness. That is
  right for OpenAPI and agent tools and wrong here, where a missing key means a
  field `Field` cannot bind. `forms-types.ts` walks the object shape itself
  (`objectShape()` and `isOptional()` from the same modules) and keeps an
  unrenderable property as `type: 'unknown'` with its `required`. The shared
  walker's behaviour for its existing callers does not change.
- **What a field carries.** `type` (`string | number | integer | boolean |
  array | object | unknown`), `required`, `nullable` (the walker renders
  `.nullable()` as a union with `null`; `forms-types.ts` folds that back into the
  inner `type` plus `nullable: true`), and the keywords with an HTML
  counterpart: `format`, `enum`, `minLength`, `maxLength`, `minimum`, `maximum`,
  `multipleOf`. A date also records `value: 'Date' | 'string'`, since the walker
  renders `z.date()` (whose input is a `Date`) and `z.coerce.date()` or
  `z.iso.datetime()` (whose input is a string) alike as `format: 'date-time'`.
- **What it leaves out.** `pattern`: the walker emits substring patterns
  (`'x'` for `.includes('x')`), while an HTML `pattern` must match the whole
  value under different compilation rules, so copying it would reject input the
  server accepts. A pipe's later stages: the input side of
  `z.string().trim().toLowerCase().pipe(z.email())` is the plain string, so no
  `format: 'email'` is derived from it. Unions such as the login page's
  `z.union([z.boolean(), z.string().transform(…)])` become `unknown`. Callers
  that know better pass `as` (section 3).
- **Warnings degrade, never fail.** Whatever the walker cannot read becomes
  `type: 'unknown'` with whatever it could read, and the warning is printed as
  codegen prints the agent manifest's. The page still renders a text input; the
  server still validates.
- **Freshness.** The motivating edit is a validator change, and today the Vite
  plugin regenerates on the routes entry, pages, resources and catalogs, not on
  `app/Http/Validators/` or the route modules the entry imports
  (`vite/route-types.ts`). That already leaves `ApiRoutes` body types stale
  after a validator edit; `forms.gen.ts` inherits the gap unless the watcher
  learns the validator directories (root and `modules/*/`) and the routes
  entry's local imports. This RFC adds both. `guren check` today only checks
  that a manifest exists (`check.ts`); for `forms.gen.ts` it renders the
  expected content in memory and reports a difference with the `codegen` fix,
  as `check --spec` does for the spec views.

The attributes are hints for the browser. The server stays the authority:
`.refine()`, `.superRefine()`, cross-field rules and transforms are invisible to
the walker, and a browser that ignores `required` still meets the route's
validation.

#### 2.2 The headless half: `@guren/inertia-client/forms`

A new subpath, beside `typed-forms` and `components`, with its own entry in
`packages/inertia-client/tsdown.config.ts` and `package.json` `exports`. It
depends on `@inertiajs/react` and `@inertiajs/core`, both already dependencies,
and re-exports `FormDataType` so a copied component needs no import from
`@inertiajs/core`.

```ts
import type { FormDataType } from '@inertiajs/core' // already a dependency of @guren/inertia-client
import type { InertiaFormProps } from '@inertiajs/react'

export interface FieldContract {
  type: 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'object' | 'unknown'
  required: boolean
  nullable?: boolean
  format?: string
  value?: 'Date' | 'string'
  enum?: readonly (string | number)[]
  minLength?: number
  maxLength?: number
  minimum?: number
  maximum?: number
  multipleOf?: number
}

export interface RouteFormContract<TName extends string, TMethod extends string, TPath extends string, TBody> {
  route: TName
  method: TMethod
  path: TPath
  fields: { [K in keyof TBody & string]?: FieldContract }
}

/** The plan view vocabulary (RFC 0030 `form.fields[].input`) plus three string formats. */
export type FieldInput =
  | 'text' | 'textarea' | 'number' | 'checkbox' | 'select' | 'date' | 'datetime'
  | 'file' | 'hidden' | 'email' | 'url' | 'password'

export type RouteForm<TBody extends FormDataType<TBody>> = InertiaFormProps<TBody> & {
  contract?: RouteFormContract<string, string, string, TBody>
  /** An `onSubmit` handler: prevents the default and calls Inertia's own `submit()`. */
  handleSubmit: (event?: { preventDefault(): void }) => void
}

export function useRouteForm<TName extends string, TMethod extends string, TPath extends string, TBody extends FormDataType<TBody>>(
  contract: RouteFormContract<TName, TMethod, TPath, TBody>,
  initial: TBody,
  // A tuple, so the options (and `params` in them) are required exactly when TPath has parameters.
  ...options: RouteFormOptionsArgs<TPath>
): RouteForm<TBody>
```

- **It wraps Inertia, it does not replace it.** `useRouteForm` calls Inertia
  3's `useForm(method, url, data)` overload, so the returned object is Inertia's
  form with its own `submit()`, `processing`, `errors`, `clearErrors()` and
  precognition methods intact, bound to the contract's method and path.
  `handleSubmit` is the only addition, and does not shadow `submit`.
- **Body constraint.** `TBody extends FormDataType<TBody>`, Inertia's recursive
  constraint. A plain `Record<string, unknown>` does not satisfy it, which is
  why `make:validator` writes `z.record(z.string(), z.any())` for JSON columns
  (`make-validator.ts`). The implementation typechecks representative bodies
  (optional keys, a JSON column, a `File`) against Inertia's own types.
- **Parameters.** `params` is typed from the literal path and substituted with
  the encoded helper `components.tsx` already uses; a token left unresolved
  throws instead of submitting to `/posts/:id`.
- **Page errors.** `options.adoptPageErrors: true` seeds the form's errors once,
  on mount, from the page's shared `errors` prop, for the redirect-back that
  was not this form's visit (the case `make:auth`'s login page handles today by
  reading page props). Nothing falls back to page errors afterwards, so two
  forms with an `email` field do not show each other's errors and
  `clearErrors()` behaves as Inertia defines it. `errorBag` passes through.

```ts
export function useField<TBody extends FormDataType<TBody>, K extends keyof TBody & string>(
  form: RouteForm<TBody> | InertiaFormProps<TBody>,
  name: K,
  overrides?: { label?: string; as?: FieldInput; hint?: string; options?: { value: TBody[K]; label: string }[] },
): FieldState<TBody[K]>

/** The default label for a field name: `startsAt` and `starts_at` both give "Starts at". */
export function humanizeFieldName(name: string): string
```

`useField` accepts a plain Inertia form too. With no contract it derives
nothing: the input comes from `as` (default `text`) and the label from `label`
or the field name. That is how a page whose route binds no body schema still
uses `Field`.

`FieldState` is a union discriminated by `input`, so each kind carries the
control props it can take rather than one `Record<string, unknown>`: `checked`
for a checkbox, `value` for text-like inputs, no `value` and a `files` handler
for a file input, options for a select. Every kind carries `id`, `label`,
`error`, `errorId`, `hint`, `hintId`, and `aria-invalid` and
`aria-describedby` while an error shows, the wiring `make:feature` writes per
field today, now written once.

**Input kind.** `as` wins. Otherwise:

| Contract | `input` | Control attributes and value handling |
|----------|---------|---------------------------------------|
| `boolean` | `checkbox` | `checked`; never `required` (a required checkbox means "must be ticked", which `z.boolean()` does not) |
| has `enum` | `select` | options from the values; the chosen option maps back to the original member, so a numeric enum submits a number |
| `integer` | `number` | `step={multipleOf ?? 1}`, `min`, `max` |
| `number` | `number` | `step={multipleOf ?? 'any'}`, `min`, `max`; without `any` the browser's default step of 1 rejects `1.5` |
| `string`, `format: 'email'` | `email` | `minLength`, `maxLength` |
| `string`, `format: 'uri'` | `url` | `minLength`, `maxLength` |
| `string`, `format: 'date'` | `date` | value sliced to `YYYY-MM-DD`, as `make:feature` does today |
| `string`, `format: 'date-time'` | `datetime` (`type="datetime-local"`) | shown in the browser's local time; submitted as an ISO string in UTC (`Z`), or as a `Date` when `value: 'Date'` |
| `string` | `text` | `minLength`, `maxLength` |
| `array`, `object`, `unknown` | `text`, with a development warning naming the field | |

`textarea`, `password`, `file` and `hidden` cannot be read off a JSON Schema,
and neither can a type the walker could not see through (a pipe, a union). The
caller states them with `as`. A file input reads `event.target.files` (the
first file, or the list when `multiple` is set) and never sets `value`.

**`required` and blank values.** JSON Schema's `required` says the key must be
present; an HTML `required` says the control must be non-empty. They differ for
`z.string()` with no `min(1)`, which accepts `''`. `useField` sets HTML
`required` only when the key is required, the field is not nullable, and the
field is not a string or has `minLength >= 1`. On submit, `useRouteForm`
normalizes a blank control: `''` becomes `null` for a nullable field, and the
key is left out for an optional field that is not nullable. This is what makes
a `.nullable().optional()` column from `make:validator` submit `null` rather
than an empty string that `.min(1)` rejects, or a `z.coerce.number()` turns
into `0`. PATCH-style dirty-field submission is out of scope.

**Edit pages.** A page submits to one route and binds that route's contract.
`make:feature`'s Edit page types its data with the `.store` body today and
submits to `.update`; it moves to `postsUpdateForm`. When an app's update
schema is a `.partial()` of the store schema, `required` disappears on the edit
form. That is correct: the server accepts the omission.

#### 2.3 The styled half: the copied `Field`

`guren add ui` writes `Field.tsx` as a thin composition the app can restyle:

```tsx
import type { ReactNode } from 'react'
import { useField, type FieldInput, type FieldState, type FormDataType, type RouteForm } from '@guren/inertia-client/forms'
import { Checkbox } from './Checkbox'
import { Input } from './Input'
import { Label } from './Label'
import { Select } from './Select'
import { Textarea } from './Textarea'

export function Field<TBody extends FormDataType<TBody>, K extends keyof TBody & string>(props: {
  form: RouteForm<TBody>
  name: K
  label?: string
  as?: FieldInput
  hint?: string
  options?: { value: TBody[K]; label: string }[]
  /** Renders the control in place of the default one; label, hint and error stay. */
  children?: (field: FieldState<TBody[K]>) => ReactNode
}) {
  const field = useField(props.form, props.name, props)
  if (field.input === 'hidden') return <input type="hidden" {...field.control} />
  return (
    <div>
      {field.input === 'checkbox' && !props.children
        ? <Checkbox {...field.control}>{field.label}</Checkbox>
        : <Label htmlFor={field.id}>{field.label}</Label>}
      {props.children ? props.children(field) : <DefaultControl field={field} />}
      {field.hint && <p id={field.hintId} className="mt-1 text-sm text-g-text-2">{field.hint}</p>}
      {field.error && <p id={field.errorId} className="mt-1 text-sm text-g-danger">{field.error}</p>}
    </div>
  )
}
```

`DefaultControl` switches on `field.input` to `Input`, `Textarea` or `Select`.
`form` is a prop rather than a context: the New and Edit pages already hold
`form`, a prop keeps each field's binding visible in the page, and `name` is
checked against that form's body type at compile time. The `children` render
prop is the escape hatch for an `object` or `array` field and for any control
the set does not cover; it receives the same `id`, `errorId` and aria props,
so a custom control keeps its label and error association.

### 3. Generators emit components

`make:feature`'s New page after this RFC, for the contract above:

```tsx
import { useRouteForm } from '@guren/inertia-client/forms'
import { postsStoreForm } from '@/.guren/forms.gen'
import { Button } from '@/resources/js/components/ui/Button'
import { Field } from '@/resources/js/components/ui/Field'

export default function NewPost() {
  const form = useRouteForm(postsStoreForm, {
    title: '', body: '', published: false, category: 'news', contactEmail: null,
  })
  return (
    <main className="min-h-screen bg-g-page font-sans text-g-text">
      <div className="mx-auto max-w-3xl px-6 py-12">
        <form className="space-y-4" onSubmit={form.handleSubmit}>
          <Field form={form} name="title" />
          <Field form={form} name="body" as="textarea" />
          <Field form={form} name="published" />
          <Field form={form} name="category" />
          <Field form={form} name="contactEmail" />
          <Button type="submit" disabled={form.processing}>Create</Button>
        </form>
      </div>
    </main>
  )
}
```

- Generators import each component from its file under
  `@/resources/js/components/ui/`, which resolves from the project root
  whatever the page's depth.
- Before writing pages, a generator calls `ensureUiComponents(appRoot, names)`
  (in `guren-css.ts`, beside `ensureGurenUiTokens()`), which writes the
  components the page imports when they are missing and never touches one that
  exists. A generated page therefore never imports a file that is not there.
- A generator passes `as` wherever its own knowledge decides an input the
  contract cannot: `textarea` for a `text` column, `date` for a `date` column
  (the walker renders `z.coerce.date()`, the shape `make:validator` writes, as
  `format: 'date-time'`). Every other `make:feature` type reaches the right row
  on its own: `z.coerce.number()` is a `number` with `step="any"`, `z.boolean()`
  a checkbox, the trimmed `z.string().min(1)` a required text input.
- A `json` field uses `Field`'s `children` render prop, keeping its own parse
  state and the second message for half-typed JSON, with the ids `useField`
  supplies. `generateFormField()`, `errorAttributes()`, `labelledControl()` and
  the `fieldIds` hook go; `fieldMessages()` shrinks to the JSON case.
- `make:feature --prototype` already writes the validator and binds it to the
  store and update routes through the shared registration builder, so its
  pages get contracts like any other, and promotion changes nothing in them.

**`make:auth`.** Its POST routes register no body schema today: each controller
validates with its own schema (`make-auth.ts`, and the blog template's
`routes/auth.ts`). Under the rule in 2.1 they would get no contracts. The
generator therefore binds each validator it already writes to its route
(`{ body: LoginSchema }` and so on, for login, register, forgot and reset
password, and profile, across every flag combination). A bound body is
enforced by the router before the action (`Router.ts`), with the same schema
and the same 422 shape; the action reads the parsed body with
`this.validated()` instead of validating it again. The pages use `Field`,
`Button` and `Alert`, and pass `as` where the schema cannot say: `email` (the
email schema is a pipe), `password`, and `checkbox` for "remember me" (a
union). The login page sets `adoptPageErrors`. `calloutRow()` goes. An app
whose auth routes stay unbound keeps working: `Field` takes a plain Inertia
form, with labels and inputs from props.

**Other output.**

- `FORM_INPUT_CLASS`, `FIELD_LABEL_CLASS`, `PRIMARY_BUTTON_CLASS` and
  `PRIMARY_SUBMIT_CLASS` are removed once nothing imports them. They are
  internal to `@guren/cli`, not exported.
- `create-guren-app`'s static templates (the blog template's `pages/auth` and
  `routes/auth.ts`, the default `Home.tsx`) adopt the components in the same
  release, so a new app and a generated page look alike. The auth scaffold
  templates byte-identical to the blog's stay so, under
  `tests/scaffold-blog-sync.test.ts`.

A design change now edits `Button.tsx` or `Field.tsx`, once.

### 4. Labels and i18n

The label is the field's accessible name, which is what a person reads and
what `getByLabel()` finds. Its resolution order is:

1. the `label` prop;
2. the translation `fields.<route>.<name>.label`
   (`fields.posts.store.title.label`), then `fields.<name>.label`, when the app
   shares `_i18n` and the key exists in the current locale or its fallback, in
   that order;
3. `humanizeFieldName(name)`.

Labels live under a `.label` leaf so that option labels can sit beside them
without a string and an object sharing one key:
`fields.category.options.news`. The translator stops at a string
(`i18n.ts`), and a key containing a dot is unreachable, so an option value that
is not a plain identifier segment has no translation key and falls back to
`humanizeFieldName(String(value))` or to `options`.

Step 2 needs to know whether a key exists. `t()` returns the key on a miss, so
the package exports a standalone `hasTranslation(i18n, key)` beside
`createTranslator()` (a new member on the exported `Translation` interface would
break any object literal typed with it), and `useField` reads `_i18n` without
the one-time warning `useTranslation()` prints, since an app without i18n is
the common case here.

Validation messages are not labels and are not changed here: they are the
strings the server put in `errors`.

The schema's `description` (`.describe()`) is not used as a label. RFC 0016
advertises it to agents as a tool parameter's description, which is usually a
sentence, not a label (Open Question 3).

### 5. Browser verification and plan views

**`getByLabel` needs an associated label, and gets one on every control.**
RFC 0033's generated specs (`packages/cli/src/browser-specs.ts`) locate each
plan view field with `page.getByLabel(label, { exact: true })`. `useField`
assigns `id` with `useId()` and the copied `Field` renders `<Label htmlFor>`,
or wraps the checkbox in its label, so every field a generator writes is
addressable. Today that guarantee is a property of two generators; after this
RFC it is a property of one component.

**The derived label is predictable, so a plan can match it.** `make:feature`
labels fields with their raw identifier today (`startsAt`), which a plan view
labelled "Starts at" never matches. With `humanizeFieldName()` as the default,
a plan written in the default locale matches the generated page unless it
chose different words, and then the page passes `label`. The CLI restates
`humanizeFieldName()` for `browser:map` and the plan page to predict labels,
pinned against the package's copy by a test, as `components.tsx` and
`routes-types-fragments.ts` already pin the path parameter helpers.

**Locale is pinned, not assumed.** A plan's labels are written in the app's
default locale, but nothing makes a browser run use it today: the Playwright
config `add browser-tests` writes sets no locale, and the server picks a locale
from the query string, a cookie or `Accept-Language` before the default
(`detect-locale.ts`), and the signed-in storage state may carry a locale
cookie. The config template sets `locale` to the app's default locale and
clears a locale cookie from the storage state, and the generated spec checks
`window.__INERTIA_PAGE__.props._i18n.locale` (when shared) before asserting
labels. Where a lang file then renames a field, the spec fails until the plan
or the lang file agrees, which is the drift the spec exists to report.

**Plan views map onto `Field` one to one.** A plan view's
`form.fields[].input` (RFC 0030, `packages/cli/src/plan/schema.ts`) uses the
vocabulary `FieldInput` starts from, so a field becomes
`<Field form={form} name={field.field} as={field.input} label={field.label} />`,
with `as` and `label` dropped where they equal what the contract derives.
`form.submitsTo` names the route whose contract the page binds. A test pins
`FieldInput` to the plan schema's enum, so the two vocabularies cannot drift.
`plan:scaffold` emits no pages today; a page emitter, when one is written,
writes this shape.

**Accessibility checks.** The axe pass in browser verification judges label
association and `aria-describedby`. Both now come from `useField`, so a
violation is fixed in one place and every page picks it up.

**Server rendering.** `useId()` gives the server and the client the same ids
only when the client hydrates the server's markup. `startInertiaClient()`'s
default setup calls `createRoot()` (`app.tsx`), so an SSR app's first render
replaces the server DOM, ids included. That is an existing limitation of the
SSR bootstrap, not one this RFC adds: ids stay consistent within the client
tree, which is all `htmlFor` needs. Moving the default setup to `hydrateRoot()`
for server-rendered pages is separate work (Open Question 7); until then the
SSR template's smoke checks labels after hydration, not in the server HTML.

### 6. Non-goals

- Client-side validation. The contract sets HTML constraints; it does not run
  the schema in the browser. Inertia 3's precognition is the route to that
  later, and `useRouteForm` keeps its methods available.
- Nested objects and arrays as generated sub-forms.
- Query-string forms (search, filters). A `query` schema could feed the same
  contract shape later.
- PATCH-style submission of dirty fields only.
- A component for every UI need. The set covers what the generators write and
  what plan views name.

## Alternatives Considered

### Ship the styled components in a package

A `@guren/ui` package would update by version bump. It was not chosen because:

- the tokens are already app-owned (`guren.css` is copied), and the markup built
  from them belongs beside them, or a design change is split across the app and
  `node_modules`;
- Tailwind v4 does not scan `node_modules`, so every app would need an
  `@source` line that a missing or stale one breaks silently;
- the first change a team makes (an icon in the button, a different error
  layout) becomes a prop the package must anticipate;
- the agent harness points agents at app code; a component the agent cannot
  edit is one it works around with inline classes, which is the problem this
  RFC removes.

The cost of copying is upgrades, handled by the doctor check and `guren
upgrade` autofix the token sheet already uses, which replace an unedited copy
and report an edited one. The headless logic is packaged for the opposite
reason: it reads `forms.gen.ts`, whose format the package owns.

### Component classes in `guren.css`

`@layer components { .g-input { @apply … } }` in the token sheet would also
make a design change a one-file edit, with no React involved. It fixes only the
class half: the label, the `aria-*` wiring and the error paragraph would still
be restated in every page, and a contract-derived field needs a component
anyway. It remains compatible with this RFC; a team may define such classes and
use them inside the copied components.

### Adopt shadcn/ui

shadcn's copy-into-the-app model is the one chosen here. Its components were not
adopted directly: they depend on Radix and on `class-variance-authority` and
`tailwind-merge`, and are styled against their own token names (`--primary`,
`--ring`), which would sit beside `--g-*` as a second vocabulary. Native
elements cover every control the generators and plan views name.

### Derive the attributes in the generator

`make:feature` could read the validator at generation time and write
`required maxLength={120}` literally. The page would then drift the first time
the validator changed, which is the problem stated above. Codegen regenerates
on every route edit; a generator runs once.

### Send the schema at run time

An endpoint serving contracts, or a shared Inertia prop, would avoid a
generated file. It adds a request or payload to every form page, a
production-reachable surface describing validators, and an SSR ordering
question, for data that is static per build.

### Import the validator into the client

Sharing the Zod schema would also enable client-side validation. Validator
files are server modules and may import server-only code, and zod would join
every page bundle. Kept out of scope with client validation itself.

## Migration Path

The change is additive for applications; nothing an existing page imports is
removed.

- **Existing pages are not rewritten.** There is no codemod: pages written by
  earlier generators have been edited, and a rewrite would have to guess which
  edits to keep. `guren add ui` writes the components; a page adopts them by
  hand. The guide shows one field before and after, the Edit page change from
  the `.store` body to the `.update` contract, and binding an auth route's
  schema.
- **New generator output uses the components** from the release that ships
  this, writing any that are missing.
- **`codegen` writes `forms.gen.ts`** in an Inertia app with a body-bound named
  route. The scaffolds commit their `.guren/*.gen.ts` files (only
  `.guren/ssr/` is ignored), so the new file is committed beside
  `routes.gen.ts`, and a template whose routes bind a body ships its first
  copy.

**Version floor.** `@guren/cli` has no dependency on `@guren/inertia-client`,
and the starters allow `^1.2.2`, which predates the `forms` subpath. An app
that upgrades the CLI alone would get a `forms.gen.ts` and generated pages
importing a subpath its client lacks, and could stop typechecking without
touching a page. So:

- codegen writes `forms.gen.ts` only when the installed client exports
  `./forms` (read from its `package.json`), and otherwise prints the
  `bun add @guren/inertia-client@^<minor>` line once;
- `make:feature`, `make:auth` and `add ui` refuse to emit an import the
  installed client cannot resolve, naming the same command;
- `guren upgrade` aligns `@guren/inertia-client` with the CLI it installs, as
  it does for the other `@guren/*` packages, and `sync:template-deps` raises the
  starters' range in the release that ships the subpath.

**Release order.** `@guren/inertia-client` (minor: the `forms` subpath,
`hasTranslation()`) publishes first; `@guren/cli` (minor: `add ui`,
`forms-types.ts`, the watcher and check changes, the generator changes) and
`create-guren-app` (minor: the templates) follow. Generated pages and copied
components resolve the client from npm, so `smoke:starter:npm` is red between
the template change and that release, as `common-pitfalls.md` describes.

**Gates that change with it.**

- `tests/generator-bytes.test.ts`, `tests/scaffold-output.test.ts` and
  `audit:starter-template` pin today's output literally.
- `tests/scaffold-builder-typecheck.test.ts` and
  `tests/make-output-typecheck.test.ts` compile rendered `make:auth` and
  `make:feature` output. They regenerate `pages.gen.ts` only today; they must
  run the full codegen so `forms.gen.ts` exists, and cover `--prototype`.
- `tests/plan-command-allowlist.test.ts` fails until `add ui` is classified.
- The `guren-ui-components` doctor check gets the case table above as tests,
  and a test fails when a component template changes without its previous
  hash joining `SHIPPED_UI_COMPONENTS`.
- `tests/scaffold-blog-sync.test.ts` pins the auth templates the blog shares.
- A new test pins `FieldInput` to the plan schema's `input` enum, and the CLI's
  copy of `humanizeFieldName()` to the package's.
- Smokes: `smoke:starter`, `smoke:starter:blog` (its auth pages change),
  `smoke:starter:api` (must stay without `forms.gen.ts`), and after the client
  release `smoke:starter:npm` and `smoke:starter:npm:blog`; the packed smoke
  checks the `forms` subpath is in the tarball's exports.
- `CLAUDE.md` and the codegen guide list the codegen artifacts; both gain
  `forms.gen.ts` and say which artifacts are conditional.

## Open Questions

1. **Edited copies.** An unedited copy is replaced by `guren upgrade`; an edited
   one is only reported. Should `add ui <name> --diff` go further and offer a
   three-way merge, using the released version the header names as the base?
   That needs every released template kept as source, not only its hash.
2. **Translation namespace.** `fields.<route>.<name>.label` then
   `fields.<name>.label`, or Laravel's `validation.attributes.<name>`, which
   would also let server messages name the field? The second couples labels to
   validation messages that do not interpolate attribute names today.
3. **`description` as hint.** Should `.describe()` fill `hint` when no
   translation exists? It is written for agents and may read badly to people.
4. **Identifier collisions.** Fail codegen on two route names that camel-case
   alike, or suffix one deterministically?
5. **Format through a pipe.** Should `forms-types.ts` take `format` from a
   pipe's output stage when its input stage is a plain string, so
   `.trim().toLowerCase().pipe(z.email())` derives `email` without an `as`? The
   output stage sees the normalized value, so the browser's check is slightly
   stricter than the server's.
6. **A check for the copied components.** Generators emit against the props
   listed above. Should `guren check` warn when a copied component no longer
   exports what generated pages import, or is `typecheck` enough?
7. **SSR hydration.** Should `startInertiaClient()`'s default setup hydrate a
   server-rendered page (`hydrateRoot()`) instead of `createRoot()`, in this
   RFC's release or separately?

## Future Work

- **A component catalog in the Dev Center**: a page listing the app's copied
  components rendered with the app's own `guren.css`, each variant and state,
  and whether the copy differs from its template version.
- **The component list in the agent harness UI rule**: the harness rule that
  tells agents to style with Guren UI tokens names `resources/js/components/ui/`
  and its components, so an agent reaches for `Field` and `Button` before
  writing inline classes.
