---
"@guren/cli": minor
---

`plan:render` and `plan:approve` now fail a plan whose `commands` run a generator for an element the plan itself adds or renames where running it first breaks a later step (`plan:command-target`). The commands run first, so `make:model`, `make:feature`, `make:policy` and the like for an element `plan:scaffold` writes left that step refusing a target that already existed, a blueprint such as `add session` or `add attachments` declared an added model's table before the data step did (`add session` with a migration too), and `make:factory` or `make:resource` for an added model failed the commands step's typecheck on a model not written yet. A stub no scaffold writes and nothing imports still passes. The finding names the element and the step that writes it. The `guren plan --print-prompt` prompt now says `commands` are for what the plan does not declare. A plan approved with such a command fails `plan:render` until the command is revised out.
