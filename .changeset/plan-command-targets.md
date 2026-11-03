---
"@guren/cli": minor
---

`plan:render` and `plan:approve` now fail a plan whose `commands` run a generator for an element the plan itself adds (`plan:command-target`). The commands run first, so `make:model`, `make:feature`, `make:policy` and the like for an added model, policy, resource, controller, validator, route or side effect (or a blueprint such as `add session` for an added model's table) left `plan:scaffold` refusing a target that already existed, and `make:factory` or `make:resource` for an added model failed the commands step's typecheck on a model not written yet. The finding names the element and the step that writes it. The `guren plan --print-prompt` prompt now says `commands` are for what the plan does not declare. A plan approved with such a command fails `plan:render` until the command is revised out.
