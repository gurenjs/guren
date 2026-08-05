---
"create-guren-app": patch
---

`create-guren-app` gives up on a stalled `git` instead of hanging

`--git` shells out to `git init`, `git add -A`, and `git commit` through
`spawnSync`, with no bound on how long any of them may take. That call blocks
the process outright, so a `git` that stops making progress leaves the user
staring at `Initializing git repository...` with the app already written to
disk — nothing to do but Ctrl-C and guess at what state the repository is in.

The child inherits no terminal, which is what makes this reachable rather than
theoretical. A commit-signing passphrase prompt, a credential helper, or a
stalled name lookup while git guesses the committer identity all wait on input
that can never arrive. It surfaced as CI test timeouts, where one wedged
`git commit` blocked the runner long enough to take down neighbouring tests too.

Every invocation now runs under a 30-second budget — one budget shared across
all three steps, so the whole call is bounded, not each subprocess
independently — and a child that overruns it is killed. The result is the
warning the scaffolder already printed when git failed outright:

```
Created a git repository, but the initial commit failed (git identity may be unset).
Set `git config user.name` and `git config user.email`, then run `git commit -m "chore: initial commit"`.
```

The children also get `GIT_TERMINAL_PROMPT=0`, so git fails fast rather than
waiting on a terminal it does not have. The probe that decides whether the
target already sits inside a repository answers "yes" when it has to be killed:
the scaffolder uses that answer to *decline* `git init`, and declining on an
unreadable answer beats nesting a repository inside the user's checkout. A
missing git still answers "no", so a machine without git stays on the
"initialize the repository manually" path rather than silently skipping the
step.

The bound is deliberately tied to how these particular children run rather than
applied to every subprocess the scaffolder starts. `bun install` and the app's
own CLI inherit the terminal — they can answer a prompt, they show progress,
and a long one is visibly working, so a deadline there would kill a slow but
healthy install. Only the git calls run silently with no terminal, where
"stalled" and "working" look identical from the user's seat.

Nothing changes for a scaffold where git behaves: the budget is far above what
`git init`/`add`/`commit` take on a fresh app, and the repository is still
created with the user's own `init.defaultBranch`, identity, and signing
configuration rather than overrides forced by the scaffolder.
