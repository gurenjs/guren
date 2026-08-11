---
'@guren/cli': patch
---

Refuse `make:feature` on an API-only app, the same way `add resource` does

`guren make:feature` reaches the same Inertia-shaped scaffold as `guren add
resource` without passing through the blueprint registry, so the refusal that
protects `add resource` did not cover it: on an API-only app it wrote the same
unusable pages, controller, resource, validator, and model. It now refuses with
the same message, after the same pure parsing — a usage error is still reported
as one — and before its first write.

Unlike the blueprints, which refuse an explicit `cwd` up front, `make:feature`
honours one, so its check judges the root it writes into rather than the
directory the process happens to sit in.
