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
strings are shared at generation time and duplicated at run time: an app with
five resources and the auth pages holds the input class in about twenty-five
places. Changing the focus ring, or the button's padding, means editing every
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
```

It is a blueprint under `add`, beside `add session` and `add browser-tests`,
and is classified as a generator in `PLAN_COMMAND_CLASSES`
(`packages/cli/src/plan/command-allowlist.ts`), so a plan may list it.

**What it writes.** One file per component under
`resources/js/components/ui/`, plus an `index.ts` barrel:

| File | Renders | Replaces |
|------|---------|----------|
| `Button.tsx` | `<button>`; `variant: 'primary' \| 'secondary' \| 'danger' \| 'ghost'`, `size: 'md' \| 'sm'`, `block`. Also exports `buttonClass(options)` for an Inertia `<Link>` styled as a button | `PRIMARY_BUTTON_CLASS`, `PRIMARY_SUBMIT_CLASS`, the Delete link on Show pages |
| `Label.tsx` | `<label>` | `FIELD_LABEL_CLASS` |
| `Input.tsx` | `<input>`, every native prop forwarded; `aria-invalid` drives the danger border | `FORM_INPUT_CLASS` |
| `Textarea.tsx` | `<textarea>`, same styling | `FORM_INPUT_CLASS` on textareas |
| `Select.tsx` | native `<select>`; `options?: { value, label }[]` or children | nothing today (plans can name `select`) |
| `Checkbox.tsx` | `<input type="checkbox">` inside its `<label>` | the inline checkbox in `generateFormField()` |
| `Field.tsx` | label, control, hint and error for one form key (section 2) | `generateFormField()`'s fifteen lines |
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
- Each file opens with a one-line header naming the component and the template
  version it was copied from (`// guren-ui: Field v1`). Nothing reads it in v1;
  it is what an upgrade command needs to tell a pristine copy from an edited
  one. How that command works is the token-upgrade work's question too, and the
  two should share one mechanism (Open Question 1).

### 2. Contract-derived fields

#### 2.1 How the schema reaches the client

The client cannot import the validator: validator files may import server-only
modules, and shipping zod to every page for a handful of attributes is the wrong
trade. Codegen already holds the runtime schema. `generateRouteTypes()` loads
registered definitions, each carrying `schemas.body` as the Zod object the
route binds, and renders it as a type through `schemaToTypeString()`. The same
definitions can be rendered as data through the JSON Schema walker
`@guren/server/internal/zod-json-schema`, which RFC 0016's agent tools and
`@guren/openapi` already share. `.guren/agents.gen.ts` is the precedent: its
`inputSchema` is a JSON Schema literal written with `renderLiteral()`.

`guren codegen` gains a fifth artifact, `.guren/forms.gen.ts`, written by a new
`packages/cli/src/forms-types.ts`:

```ts
// Generated from routes/web.ts — DO NOT EDIT
import type { RouteFormContract } from '@guren/inertia-client/forms'
import type { ApiRoutes } from './api-client.gen'

export const postsStoreForm: RouteFormContract<'posts.store', ApiRoutes['posts.store']['body']> = {
  route: 'posts.store',
  method: 'POST',
  path: '/posts',
  fields: {
    title: { type: 'string', required: true, minLength: 1, maxLength: 120 },
    body: { type: 'string', required: true, minLength: 1 },
    published: { type: 'boolean', required: false },
    category: { type: 'string', required: true, enum: ['news', 'howto'] },
    contactEmail: { type: 'string', required: false, nullable: true, format: 'email' },
  },
}

export const postsUpdateForm: RouteFormContract<'posts.update', ApiRoutes['posts.update']['body']> = { … }
```

- **Which routes.** Every named route whose `body` schema
  `readObjectSchema(body, warnings, label, 'input')` reads as an object.
  `io: 'input'` because the form describes what the browser sends, the side
  `ApiRoutes.body` already renders. A route with no body schema, or one that is
  not an object, gets no export.
- **One export per route, not one map.** A page imports only the contract it
  submits to, so a bundler drops the rest. The identifier is the route name in
  camel case plus `Form` (`posts.store` → `postsStoreForm`). Two route names
  that camel-case alike fail codegen with both names in the message
  (Open Question 4).
- **Flat keys only in v1.** Top-level properties become fields. A property
  whose type is `object` or `array` is emitted with `type` and `required` only,
  so `Field` can still bind it with an explicit `as` or children.
- **What a field carries.** `type` (`string | number | integer | boolean |
  array | object | unknown`), `required` (from the object's `required` set),
  `nullable`, and the keywords the walker emits that have an HTML counterpart:
  `format`, `enum`, `minLength`, `maxLength`, `minimum`, `maximum`, `pattern`.
  Nothing else is copied, so the artifact stays small and its shape is the
  package's to version.
- **Warnings degrade, never fail.** A node the walker cannot read becomes
  `type: 'unknown'` with whatever it could read, and the walker's warning is
  printed as codegen prints the agent manifest's. The page still renders a text
  input; the server still validates.
- **Freshness.** The Vite plugin already regenerates on route edits; the new
  file joins the set `guren check` and `guren doctor --fix` treat as generated
  (`fix: { kind: 'command', args: ['codegen'] }`), so a stale contract is
  reported like a stale `routes.gen.ts`.

The attributes are hints for the browser. The server stays the authority:
`.refine()`, `.superRefine()`, cross-field rules and transforms are invisible to
the walker, and a browser that ignores `required` still meets `validateBody()`.

#### 2.2 The headless half: `@guren/inertia-client/forms`

A new subpath, beside `typed-forms` and `components`. It depends on
`@inertiajs/react` (already a dependency) and nothing new.

```ts
export type FieldType = 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'object' | 'unknown'

export interface FieldContract {
  type: FieldType
  required: boolean
  nullable?: boolean
  format?: string
  enum?: readonly (string | number)[]
  minLength?: number
  maxLength?: number
  minimum?: number
  maximum?: number
  pattern?: string
}

export interface RouteFormContract<TName extends string, TBody> {
  route: TName
  method: 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  path: string
  fields: { [K in keyof TBody & string]?: FieldContract }
}

/** The plan view vocabulary (RFC 0030 `form.fields[].input`) plus three string formats. */
export type FieldInput =
  | 'text' | 'textarea' | 'number' | 'checkbox' | 'select' | 'date' | 'datetime'
  | 'file' | 'hidden' | 'email' | 'url' | 'password'

/** Inertia's useForm, bound to the contract's route; `submit` substitutes `params` into its path. */
export function useRouteForm<TName extends string, TBody extends Record<string, unknown>>(
  contract: RouteFormContract<TName, TBody>,
  initial: TBody,
  options?: { params?: Record<string, string | number> },
): RouteForm<TName, TBody>

export interface FieldState {
  id: string
  label: string
  input: FieldInput
  error?: string
  errorId: string
  hint?: string
  hintId: string
  options?: { value: string; label: string }[]
  /** Spread onto the control: id, name, type, required, minLength, maxLength, min, max, step,
      pattern, value or checked, onChange, aria-invalid, aria-describedby. */
  controlProps: Record<string, unknown>
}

export function useField<TBody, K extends keyof TBody & string>(
  form: RouteForm<string, TBody>,
  name: K,
  overrides?: { label?: string; as?: FieldInput; hint?: string; options?: FieldState['options'] },
): FieldState

/** The default label for a field name: `startsAt` and `starts_at` both give "Starts at". */
export function humanizeFieldName(name: string): string
```

**Input kind.** `as` wins. Otherwise:

| Contract | `input` | Extra attributes |
|----------|---------|------------------|
| `boolean` | `checkbox` | `checked` instead of `value` |
| has `enum` | `select` | `options` from the values, labelled with `humanizeFieldName` |
| `integer` | `number` | `step={1}` |
| `number` | `number` | `min`, `max` from `minimum`, `maximum` |
| `string`, `format: 'email'` | `email` | |
| `string`, `format: 'uri'` | `url` | |
| `string`, `format: 'date'` | `date` | value sliced to `YYYY-MM-DD`, as `make:feature` does today |
| `string`, `format: 'date-time'` | `datetime` (`type="datetime-local"`) | |
| `string` | `text` | `minLength`, `maxLength`, `pattern` |
| `array`, `object`, `unknown` | `text`, with a development warning naming the field | |

`textarea`, `password`, `file` and `hidden` cannot be read off a JSON Schema;
the caller states them with `as`. `make:feature` knows a `text` column is a
textarea, `make:auth` knows which fields are passwords, and a plan view names
the input outright. `required` is set only when the contract says so and the
field is not a checkbox (a required checkbox means "must be ticked", which a
`z.boolean()` does not).

**Errors.** `error` is `form.errors[name]`, falling back to the page's shared
`errors` prop for a redirect-back that was not this form's visit (the case
`make:auth`'s login page handles by reading page props today). An array keeps
its first message. While an error shows, `controlProps` carries
`aria-invalid` and `aria-describedby={errorId}`, the wiring `make:feature`
writes per field today, now written once.

**Edit pages.** A page submits to one route and binds that route's contract.
`make:feature`'s Edit page types its data with the `.store` body today and
submits to `.update`; it moves to `postsUpdateForm`. When an app's update
schema is a `.partial()` of the store schema, `required` disappears on the edit
form. That is correct: the server accepts the omission.

#### 2.3 The styled half: the copied `Field`

`guren add ui` writes `Field.tsx` as a thin composition the app can restyle:

```tsx
import { useField, type FieldInput, type RouteForm } from '@guren/inertia-client/forms'
import { Checkbox } from './Checkbox'
import { Input } from './Input'
import { Label } from './Label'
import { Select } from './Select'
import { Textarea } from './Textarea'

export function Field<TBody, K extends keyof TBody & string>(props: {
  form: RouteForm<string, TBody>
  name: K
  label?: string
  as?: FieldInput
  hint?: string
}) {
  const field = useField(props.form, props.name, props)
  if (field.input === 'hidden') return <input type="hidden" {...field.controlProps} />
  return (
    <div>
      {field.input === 'checkbox'
        ? <Checkbox {...field.controlProps}>{field.label}</Checkbox>
        : <Label htmlFor={field.id}>{field.label}</Label>}
      {field.input === 'textarea' && <Textarea {...field.controlProps} />}
      {field.input === 'select' && <Select options={field.options} {...field.controlProps} />}
      {!['checkbox', 'textarea', 'select'].includes(field.input) && <Input {...field.controlProps} />}
      {field.hint && <p id={field.hintId} className="mt-1 text-sm text-g-text-2">{field.hint}</p>}
      {field.error && <p id={field.errorId} className="mt-1 text-sm text-g-danger">{field.error}</p>}
    </div>
  )
}
```

`form` is a prop rather than a context. The New and Edit pages already hold
`form`, a prop keeps each field's binding visible in the page, and `name` is
checked against that form's body type at compile time.

### 3. Generators emit components

`make:feature`'s New page after this RFC:

```tsx
import { useRouteForm } from '@guren/inertia-client/forms'
import { postsStoreForm } from '@/.guren/forms.gen'
import { Button, Field } from '@/resources/js/components/ui'

export default function NewPost() {
  const form = useRouteForm(postsStoreForm, { title: '', body: '', published: false })
  return (
    <main className="min-h-screen bg-g-page font-sans text-g-text">
      <div className="mx-auto max-w-3xl px-6 py-12">
        <form className="space-y-4" onSubmit={form.submit}>
          <Field form={form} name="title" />
          <Field form={form} name="body" as="textarea" />
          <Field form={form} name="published" />
          <Button type="submit" disabled={form.processing}>Create</Button>
        </form>
      </div>
    </main>
  )
}
```

- Generators import from `@/resources/js/components/ui`, which resolves from
  the project root whatever the page's depth.
- Before writing pages, a generator calls `ensureUiComponents(appRoot, names)`
  (in `guren-css.ts`, beside `ensureGurenUiTokens()`), which writes the
  components the page imports when they are missing and never touches one that
  exists. A generated page therefore never imports a file that is not there.
- `generateFormField()`, `fieldMessages()`, `errorAttributes()`,
  `labelledControl()` and the `fieldIds` hook go. A `json` field stays
  generator-written, composed from `Label` and `Textarea` directly, since its
  parse error is client state the contract cannot know.
- `make:auth`'s login, register, password and profile pages use `Field`,
  `Button` and `Alert`; `calloutRow()` goes.
- `make:feature --prototype` pages (`make-feature-prototype.ts`) share the page
  generators and follow. A prototype route has no body schema until promoted,
  so its pages bind a contract the prototype fixture declares (Open Question 5).
- `FORM_INPUT_CLASS`, `FIELD_LABEL_CLASS`, `PRIMARY_BUTTON_CLASS` and
  `PRIMARY_SUBMIT_CLASS` are removed once nothing imports them. They are
  internal to `@guren/cli`, not exported.
- `create-guren-app`'s static templates (the blog template's `pages/auth`, the
  default `Home.tsx`) adopt the components in the same release, so a new app
  and a generated page look alike.

A design change now edits `Button.tsx` or `Field.tsx`, once.

### 4. Labels and i18n

The label is the field's accessible name, which is what a person reads and
what `getByLabel()` finds. Its resolution order is:

1. the `label` prop;
2. the translation `fields.<route>.<name>` (`fields.posts.store.title`), then
   `fields.<name>`, when the app shares `_i18n` and the key exists;
3. `humanizeFieldName(name)`.

Step 2 needs to know whether a key exists. `t()` returns the key on a miss, so
`Translation` gains an additive `has(key)`, and `useField` reads `_i18n`
without the one-time warning `useTranslation()` prints, since an app without
i18n is the common case here. Select option labels resolve the same way under
`fields.<name>.options.<value>`.

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

**Locale.** Browser specs run the app under its default locale. A plan's labels
are written in that locale. Where a lang file renames a field, the spec fails
until the plan or the lang file agrees, which is the drift the spec exists to
report.

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

### 6. Non-goals

- Client-side validation. The contract sets HTML constraints; it does not run
  the schema in the browser.
- Nested objects and arrays as generated sub-forms.
- Query-string forms (search, filters). A `query` schema could feed the same
  contract shape later.
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

The cost of copying is upgrades, handled by the header and the shared upgrade
mechanism (Open Question 1). The headless logic is packaged for the opposite
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
  hand. The guide shows one field before and after, and the Edit page change
  from the `.store` body to the `.update` contract.
- **New generator output uses the components** from the release that ships
  this, writing any that are missing.
- **`codegen` writes `forms.gen.ts`** in every app with a body-bound named
  route. The scaffolds commit their `.guren/*.gen.ts` files (only
  `.guren/ssr/` is ignored), so the new file is committed beside
  `routes.gen.ts`, and a template whose routes bind a body ships its first
  copy.

Release order and gates:

- `@guren/inertia-client` (minor: the `forms` subpath, `Translation.has()`)
  must be published before generators emit the import. Generated pages and
  copied components resolve it from npm, so `smoke:starter:npm` is red between
  the template change and that release, as `common-pitfalls.md` describes.
- `@guren/cli` (minor): `add ui`, `forms-types.ts`, the generator changes.
  `tests/generator-bytes.test.ts`, `tests/scaffold-output.test.ts` and
  `audit:starter-template` pin today's output literally and change with it;
  `tests/plan-command-allowlist.test.ts` fails until `add ui` is classified.
- `create-guren-app` (minor): the templates adopt the components; run
  `smoke:starter` and `smoke:starter:api` (the API template must stay
  untouched).
- `CLAUDE.md` and the codegen guide name four artifacts plus `agents.gen.ts`;
  both gain `forms.gen.ts`.

## Open Questions

1. **Upgrading copied components.** The header records the template version.
   Should `guren add ui --diff` (or `guren upgrade`) compare a copy against its
   template version and offer the new one when the copy is unedited? The
   `guren.css` upgrade work answers the same question for the token sheet; one
   mechanism should serve both.
2. **Translation namespace.** `fields.<route>.<name>` then `fields.<name>`, or
   Laravel's `validation.attributes.<name>`, which also lets server messages
   name the field? The second couples labels to validation messages that do
   not interpolate attribute names today.
3. **`description` as hint.** Should `.describe()` fill `hint` when no
   translation exists? It is written for agents and may read badly to people.
4. **Identifier collisions.** Fail codegen on two route names that camel-case
   alike, or suffix one deterministically?
5. **Prototype pages.** Should the prototype fixture declare field contracts so
   prototype forms derive the same attributes before a validator exists, or
   should prototype pages pass `as`/`label` explicitly until promoted?
6. **A check for the copied components.** Generators emit against the props
   listed above. Should `guren check` warn when a copied component no longer
   exports what generated pages import, or is `typecheck` enough?

## Future Work

- **A component catalog in the Dev Center**: a page listing the app's copied
  components rendered with the app's own `guren.css`, each variant and state,
  and whether the copy differs from its template version.
- **The component list in the agent harness UI rule**: the harness rule that
  tells agents to style with Guren UI tokens names `resources/js/components/ui/`
  and its components, so an agent reaches for `Field` and `Button` before
  writing inline classes.
