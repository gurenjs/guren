---
"@guren/server": patch
"@guren/orm": patch
---

Identify hot-reload owners correctly when a path or a function name contains
parentheses

Under `bun --hot`, both packages key what a reload must tear down — timers for
cache stores, schedulers, rate limiters and broadcast managers; clients for
database connections — on the file that built it, read out of a stack frame
whose location is wrapped in parentheses: `at make (/app/x.ts:3:1)`.

`@guren/server` could not read that shape at all when the path itself
contained parentheses, which is an ordinary macOS directory name
(`~/Projects (2024)`). The rejected frame was not simply lost: the frame walk
falls through to the next frame that does parse — a *different* file, further
out — so two owners reached from one place shared a slot, and building the
second stopped the first's live timer.

`@guren/orm` could read a path with parentheses, but by taking the frame's
*leftmost* `(` — which gets the wrong pair when the *function name* in front
of the location has parentheses instead. Bun emits exactly that shape for a
method whose key carries them: `at weird (name) (/app/x.ts:3:1)`. Leftmost
matching reads that as `name) (/app/x.ts`, which is not a path but is stable
enough to be used as a key — worse than losing the frame, because on the
server side the same rule also swallows the `unknown` marker of an implicit
constructor, defeating the filter that stops every such owner from collapsing
into one slot.

Neither the leftmost nor the rightmost `(` is right in general — a path with
parentheses needs the first, a function name with parentheses needs the last.
Both packages now find the location by scanning back from the frame's final
`)` and counting nesting depth, so it is bounded by whichever parenthesis
actually matches it. Frames without parentheses in either position parse to
exactly what they did before.

An `eval` frame — `at eval (eval at <anonymous> (/app/x.ts:1:2), <anonymous>:1:1)`
— is now rejected outright rather than read as a path: the location it
contains belongs to the `eval` call site, not to the owner under construction,
and using it as a key would drift on any edit to the line the `eval` occurs
on. An owner with no key is left alone, which is the safe failure everywhere
else in these registries.
