---
paths:
  - "resources/js/**"
  - "resources/css/**"
---

# UI: Guren UI tokens

Pages style with the Guren UI design tokens: the `--g-*` custom properties in
`resources/css/guren.css`, which `resources/css/app.css` imports and maps onto
Tailwind as `g-` utilities (`bg-g-page`, `text-g-accent-text`, `border-g-line`,
`rounded-g-card`, `shadow-g-card`). Every color, radius and shadow on a page
comes from them. An app with no `guren.css` gets one, with its import, from the
first `bunx guren make:feature` or `make:auth`.

## The tokens

| Role | Tokens (`--g-…`) | Use |
|------|------------------|-----|
| Surfaces | `page`, `panel`, `raised`, `ink`, `line`, `line-strong` | `bg-g-page` on the page shell, `bg-g-panel` on cards and inputs, `border-g-line` / `border-g-line-strong` on edges; `ink` is a code or terminal surface, dark in both schemes |
| Text | `heading`, `text`, `text-2`, `muted` | headings, body, secondary text, placeholders and hints |
| On ink | `on-ink`, `on-ink-muted` | text printed on `bg-g-ink` |
| Accent | `accent`, `accent-down`, `accent-text`, `accent-tint`, `on-accent` | `bg-g-accent` (hover `bg-g-accent-down`) with `text-g-on-accent` fills the primary action; `text-g-accent-text` is links and accent text, never `text-g-accent` (crimson fails contrast on the dark ground) |
| Signals | `ok`, `warn`, `danger`, each with `-chip` and `-tint` | the plain token is text (`text-g-danger` for a field error), `-chip` is a border, dot or badge fill, `-tint` is a wash behind it |
| Geometry | `r-ctl`, `r-card`, `shadow-card`, `shadow-float` | `rounded-g-ctl` on controls, `rounded-g-card` on cards, `shadow-g-card`, `shadow-g-float` on popovers |
| Type | `font-sans`, `font-mono` | `font-sans` on the page shell, `font-mono` for code and numbers |
| Tick | `tick` | `bg-[image:var(--g-tick)]` on a thin bar marking the current place, once per screen |

Each color token is mapped as `--color-g-<name>`, so it works with every
Tailwind color prefix (`bg-`, `text-`, `border-`, `outline-`, `accent-`,
`placeholder:`).

## The red budget

- `bg-g-accent` fills **one element per screen**: the primary action (a form's
  submit, an index page's "New post"). Every other action is a secondary
  button or a text link.
- A destructive action is an **outline with an explicit verb** ("Delete",
  "Remove member", never "OK" or "Yes"): no red fill on the page where it sits.
- The red fill moves to the destructive action only **inside a confirm step**
  (the dialog or page that asks "Delete this post?"), where it is that step's
  one fill and the cancel beside it is secondary.

## Dark mode

`guren.css` redefines the tokens under `@media (prefers-color-scheme: dark)`,
so a page written in tokens is right in both schemes with nothing else to do.
Never write a raw palette color (`text-gray-500`, `bg-red-600`, `bg-white`),
an arbitrary color (`text-[#333]`, `bg-[rgb(…)]`), an inline `style` color, or a
`dark:` pair (`bg-white dark:bg-slate-900`): each hard-codes values the tokens
already switch, and drifts from the theme the moment `guren.css` changes. A
color no token covers is a new token in `resources/css/app.css`, after the
`guren.css` import and under the app's own prefix (`--app-…`, so a later
`guren.css` cannot collide with it): its light value in `:root`, its dark value
in the same media query, and a `--color-app-…` line in `@theme inline`.

## The shared class strings

The scaffolded pages (`make:feature`, `make:auth`) use these strings. Reuse
them for the same element rather than writing a new input or button style:

| Element | Classes |
|---------|---------|
| Page shell | `min-h-screen bg-g-page font-sans text-g-text` |
| Field label | `block text-sm font-bold text-g-heading` |
| Text input, textarea, select | `w-full rounded-g-ctl border border-g-line-strong bg-g-panel px-3 py-2 text-g-text transition outline-none placeholder:text-g-muted focus:border-transparent focus:outline-2 focus:-outline-offset-1 focus:outline-g-accent` (after `mt-1` under its label) |
| Checkbox | `h-4 w-4 rounded accent-g-accent` |
| Field error | `mt-1 text-sm text-g-danger` |
| Primary button | `rounded-g-ctl bg-g-accent px-4 py-2 text-sm font-bold text-g-on-accent transition hover:bg-g-accent-down` |
| Full-width submit | the primary button plus `w-full` first and `disabled:cursor-not-allowed disabled:opacity-45` last |
| Secondary button | `rounded-g-ctl border border-g-line-strong bg-g-panel px-4 py-2 text-sm font-bold text-g-text transition hover:border-g-muted` |
| Destructive button | `rounded-g-ctl border border-g-danger-chip px-3 py-1 text-sm font-bold text-g-danger transition hover:bg-g-danger-tint` |
| Text link | `text-g-accent-text transition hover:underline` |
| Card | `rounded-g-card border border-g-line bg-g-panel p-4 shadow-g-card` |

When a page repeats one of these, lift it into a constant or a component in
the app rather than letting the copies diverge.
