---
'@guren/cli': patch
---

The agent harness ships a `ui.md` rule, loaded when an agent edits `resources/js/**` or `resources/css/**`: the `--g-*` design tokens in `resources/css/guren.css` and the `g-` utilities they map to, the red budget (`bg-g-accent` fills one primary action per screen, a destructive action is an outline with an explicit verb and takes the red fill only inside a confirm step), dark mode through the tokens rather than raw colors or `dark:` pairs, and the class strings `make:feature` and `make:auth` emit for inputs, labels and buttons. `agent:sync` installs it in existing apps.
