---
"@guren/cli": patch
---

Controller actions written as class fields (`store = async () => {}`, `show = () => this.inertia(...)`) are now recognised everywhere the CLI reads a controller.

`Router` dispatches to a function-valued class field exactly as it does to a method declaration, but four of the five class-member walks in the CLI tested only for a method declaration. `guren check` and `guren doctor --next` never reported an empty field action, `guren context <Entity>` left one out of the bundle entirely with nothing to say it had been skipped, and `spec:generate`'s screens view attributed the page such an action renders to no route at all. All five now share one answer to which members of a controller are actions, and member names are read through the same rule the rest of the CLI uses — so a quoted key (`'store'() {}`) counts, and a computed one (`[store]() {}`) is skipped rather than guessed at from its literal text.
