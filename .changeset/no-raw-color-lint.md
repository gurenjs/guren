---
'@guren/cli': minor
'create-guren-app': minor
---

`@guren/cli/oxlint` adds `guren/no-raw-color`, which reports a raw color where a Guren UI token belongs: a Tailwind palette utility (`bg-red-500`, `text-zinc-500`, `border-white/10`) or an arbitrary color value (`bg-[#db1b1b]`, `[color:#fff]`) in any string but a non-class JSX attribute such as `title`, and a hex, color-function or named-color value in a JSX `style` prop or an SVG `fill`/`stroke`. The `.oxlintrc.json` that `create-guren-app` and `guren add lint` write enables it as an error on `resources/js/**`, so a page that styles with `bg-white` instead of `bg-g-panel` fails `bun run lint` and `guren gate`. `guren add lint` leaves the rule out for an app with no `resources/css/guren.css`, which has no tokens to switch to. An app that already has a config keeps it; add the override by hand to opt in. The `guren add admin` dashboard now styles with the tokens too, and writes `resources/css/guren.css` when the app has none.
