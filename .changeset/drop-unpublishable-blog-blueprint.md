---
"create-guren-app": minor
"@guren/cli": patch
---

Remove the `blog` blueprint and guard against unpublishable template layers

`--blueprint blog` never worked from a published `create-guren-app`. Its overlay
layer resolved to `examples/blog`, which lives outside the package and is not
covered by the `files` field, so from npm the command failed with a raw ENOENT
inside `cp` after already copying the base template — leaving a half-scaffolded
directory behind. `--help` advertised the blueprint the whole time.

The blueprint was also broken independently of packaging: its hand-maintained
copy of the blog schema had drifted from the columns its controllers used, and
it pinned `@inertiajs/core` to a major version behind the `@inertiajs/react` the
template installs, so a generated app did not typecheck even inside the
monorepo. Restoring it means shipping a curated template under `templates/` with
smoke coverage, which is tracked separately; advertising it meanwhile was worse
than removing it. `--blueprint blog` now reports the blueprints that do exist.

Template layers are now named rather than pathed, so a layer outside the
published `templates/` directory is a type error instead of something a test has
to catch. `scaffoldAppBlueprint()` also verifies each template exists before it
copies anything, so a corrupted install reports which blueprint and directory are
missing instead of an ENOENT, rather than failing part-way through the copy.
