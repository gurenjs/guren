---
name: scaffold
description: Generate one component with `bunx guren make:*` (controller, model, page, middleware, job, event, mail, test, resource, validator, migration, …). A whole entity is the feature skill.
---

# Scaffold Skill

Generate a component with its `make:*` command rather than writing the file by
hand: the generated file carries the imports, base class and location the rest
of the framework (codegen, `guren check`) expects.

> When editing the generated files, the verified API rules live in `__RULES_DIR__/*.md` (each file's `paths` frontmatter states the paths it covers), with the full references in `__SKILLS_DIR__/guren-api/reference/`.

## Available CLI Commands

```bash
bunx guren make:controller <Name>
bunx guren make:model <Name>
bunx guren make:view <path>
bunx guren make:middleware <Name>
bunx guren make:job <Name>
bunx guren make:event <Name>
bunx guren make:listener <Name> --event=<EventName>
bunx guren make:mail <Name>
bunx guren make:test <Name>         # the runner is detected from the project; --runner=bun|vitest overrides
bunx guren make:resource <Name> --model=<Model>
bunx guren make:policy <Name>
bunx guren make:validator <Name> [--fields "<field:type,...>"]
bunx guren make:factory <Name> --model=<Model>
bunx guren make:seeder <Name>
bunx guren make:provider <Name>
bunx guren make:command <Name> --command=<cmd>
bunx guren make:exception <Name> --status=<code>
bunx guren make:channel <Name> [--private|--presence]
bunx guren make:notification <Name>
bunx guren make:migration <name>
bunx guren make:route <Name>
bunx guren make:module <Name>       # scaffolds modules/<name>/ (see below)
bunx guren make:ai-agent <Name> [--tools a,b] [--output] [--test]  # in-process AI agent (needs `bunx guren add ai`)
```

If the project has a `modules/` directory, check whether the component belongs inside an existing module before scaffolding at the project root — most `make:*` commands accept `--module <name>` to output into `modules/<name>/` instead (e.g. `bunx guren make:controller Invoice --module billing`). `make:auth` and `make:migration` don't take `--module`.

## What goes with what

Generate what the request needs to work, in the same turn, without stopping to
ask about each piece: a listener for an event that nothing would otherwise
handle, a test for a controller the task asked to be tested. Leave out the
companions the request did not ask for and does not need, and mention them in
one line at the end.

- Controller → model, views, test
- Model → the table in `db/schema.ts` and its migration, factory, seeder
- Event → listener
- Job → the event that dispatches it, when one does
- Mail → notification, when it is part of a notification flow

## Output Locations

| Component | Location |
|-----------|----------|
| Controller | `app/Http/Controllers/{Name}Controller.ts` |
| Model | `app/Models/{Name}.ts` |
| View | `resources/js/pages/{path}.tsx` |
| Middleware | `app/Http/Middleware/{Name}Middleware.ts` |
| Job | `app/Jobs/{Name}Job.ts` |
| Event | `app/Events/{Name}.ts` |
| Listener | `app/Listeners/{Name}Listener.ts` |
| Mail | `app/Mail/{Name}Mail.ts` |
| Test | `tests/{path}/{Name}.test.ts` |
| Resource | `app/Http/Resources/{Name}Resource.ts` |
| Validator | `app/Http/Validators/{Name}Validator.ts` |
| Factory | `db/factories/{Name}Factory.ts` |
| Seeder | `db/seeders/{Name}Seeder.ts` |
| Provider | `app/Providers/{Name}Provider.ts` |
| Command | `app/Console/Commands/{Name}Command.ts` |
| Exception | `app/Exceptions/{Name}Exception.ts` |
| Channel | `app/Broadcasting/{Name}Channel.ts` |
| Notification | `app/Notifications/{Name}Notification.ts` |

## MCP Alternative

If the dev server is running, the `guren_make_component` MCP tool can generate individual components without shell access.
Supported types: controller, model, view, test, route. Other types fall back to CLI.
