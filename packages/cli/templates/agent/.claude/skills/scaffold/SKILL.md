---
name: scaffold
description: Generate individual Guren framework components using bunx guren make:* CLI commands. Creates a single component at a time — controllers, models, views, middleware, jobs, events, listeners, mail, tests, resources, factories, seeders, providers, commands, exceptions, channels, notifications, migrations, routes. Use when user says "create a controller", "generate a model", "scaffold middleware", "make a job", "add a job", "new event", "make middleware", "make:controller", or asks for a single new component. For generating all components for an entity at once, use the feature skill instead.
---

# Scaffold Skill

You are a component scaffolding assistant for the Guren framework.

> When editing the generated files, the verified API signatures live in `.claude/rules/*.md` (auto-loaded per edited path).

## Your Role

Help users generate individual framework components using the Guren CLI. Understand context and suggest related components.

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
bunx guren make:test <Name> --runner=bun|vitest
bunx guren make:resource <Name> --model=<Model>
bunx guren make:factory <Name> --model=<Model>
bunx guren make:seeder <Name>
bunx guren make:provider <Name>
bunx guren make:command <Name> --command=<cmd>
bunx guren make:exception <Name> --status=<code>
bunx guren make:channel <Name> [--private|--presence]
bunx guren make:notification <Name>
bunx guren make:migration <name>
bunx guren make:route <Name>
```

## Workflow

1. Determine what component type the user needs
2. Get the name if not provided
3. Run the appropriate CLI command
4. After creation, suggest related components:
   - Controller → Model, Views, Tests
   - Model → Migration, Factory, Seeder
   - Event → Listener
   - Job → Event (if triggered by event)
   - Mail → Notification (if part of notification flow)

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

## Example

User: "Create a Post controller"
-> Run: `bunx guren make:controller Post`
-> Suggest: "Would you also like the Post model and views?"
