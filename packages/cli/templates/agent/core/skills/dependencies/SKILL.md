---
name: dependencies
description: "Add, upgrade or remove a package, or fix a security advisory, with guren deps:why, deps:exposure and guren audit's verified fixes behind the minimumReleaseAge gate (\"bun add X\", \"upgrade X\", \"vulnerability\", \"CVE\", \"advisory\", \"audit failed\")."
---

# Dependencies Skill

`guren audit` reads `bun audit`'s advisories and the Bun runtime's own, says which
routes reach each flagged version, and proposes a fix it has resolved in a copy
of the app. Read what it reports before changing `package.json` by hand.

## Before adding or upgrading a package

```bash
bunx guren deps:why <package>                  # every installed version, which direct dependency brings it in, production or not
bunx guren deps:exposure --package <package>   # the files importing it, where they run (server, client, ssr, build, test), the routes reaching them
```

- Prefer a package already installed (`deps:why` exits 1 when it is not) over a
  second one for the same job.
- A package the browser bundle imports runs on every visitor's machine: check
  `deps:exposure` shows the placement you expect.
- `bunfig.toml` holds back versions published less than three days ago
  (`minimumReleaseAge`). `bun add` failing with `blocked by minimum-release-age`
  is that gate working: pick an older version or wait. Never delete the gate or
  lower it to 0.

## Fixing an advisory

```bash
bunx guren audit          # add --json for keys, advisory ranges, exposures and fixes
```

1. Under each `deps:*` advisory the audit lists the installed versions in range
   and the routes reaching each. "reaches every route through @guren packages"
   means only the framework pulls it in: update the `@guren/*` packages to a
   release that moved off it (then `bunx guren upgrade --check-only`) rather
   than overriding it.
2. Apply the `fix` it prints. `fix (verified)` was resolved with
   `bun install --lockfile-only` in a temporary copy, so the lockfile it leaves
   has no version in range. `candidate` was not checked; its reason says why.
   A fix that updates a direct dependency comes before an `overrides` entry.
3. When the fixed version is younger than the gate, the fix includes a step
   adding that exact `name@version` to `minimumReleaseAgeExcludes`. Add that one
   entry, never a bare package name.
4. Run `bun install`, then `bunx guren audit` again until the advisory is gone,
   then `bunx guren gate`.

An advisory you cannot fix yet (no patched release) goes in `config/audit.ts`
under `ignore` with its key and a `reason`, and only after the user agrees. A
high or critical advisory fails `guren audit` until it is fixed or recorded.

## The Bun runtime

`deps:runtime:<GHSA>` means a Bun version the app names (the running Bun,
`engines.bun`, `packageManager`, an `oven/bun` image in a root Dockerfile) is
inside a Bun advisory: raise it to the patched release the finding names.
`deps:runtime-unpinned` is an image tag with no exact version or digest;
`bunx guren deploy` writes `oven/bun:<version>@sha256:…`, so do not hand-edit
it back to `oven/bun:1`. `deps:runtime-scan` means api.github.com did not
answer (set `GITHUB_TOKEN`); it is not a clean result.

## Reading the result honestly

Both `guren audit` and `deps:exposure` end with "What these results rest on
without checking": readers that stopped short, graph entries left unresolved,
fixes left as `candidate`, values the response check could not follow. Report
those as unchecked, not as clean. `deps:exposure` exits 1 while any reader is
incomplete, so name what that section lists rather than treating the exit code
as a verdict on the package.

`exposure-sensitive-column:<Model>.<column>:…` is the audit's other data
finding: a `hidden` column or one named like `password`, `token`, `secret`,
`hash`, `apiKey` or `otp` reaching `this.inertia()` props, `this.json()` or a
Resource. Send a Resource or `User.serialize(user)` (which drops `hidden`)
instead of the whole record.

## Setup checks

`bunx guren doctor` reports `supply-chain-cooldown` when `bunfig.toml` has no
`minimumReleaseAge`, or its `minimumReleaseAgeExcludes` leaves out an `@guren`
package the app has (a Guren upgrade would then be blocked). `bunx guren upgrade`
adds the missing lines when it wrote the block; otherwise doctor prints the line.

For a scheduled watch, commit `bunx guren audit --json > audit-baseline.json`
and run `bunx guren audit --deps-baseline audit-baseline.json` daily with
`GITHUB_TOKEN` set: it exits 1 on an advisory key the baseline lacks and on a
scan that did not complete. Regenerate the baseline after each fix.

Full guide: https://guren.dev/docs/guides/operations (Dependency Updates).
