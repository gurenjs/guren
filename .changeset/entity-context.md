---
'@guren/server': minor
'@guren/cli': minor
---

feat: entity-centric context bundles (RFC 0004 Part 1)

- `guren context <Entity>` joins everything the CLI knows about one model
  into a single markdown/JSON bundle: model metadata (table, columns,
  relationships, reverse references), routes with validation schemas,
  controller actions, Inertia pages with extracted Props, resource,
  policy, factories, seeders, and tests. Same-named models across
  modules are disambiguated with `--module` (`--module app` selects the
  application root), and every join is scoped to the selected location
  when the name is duplicated.
- `guren context` (whole-project) now reports routes from the full
  `RouteDefinition` payload — the Routes table gains a Controller column
  and JSON output includes controller bindings and schema type strings.
- `RouteDefinition` gains `bindings` (param name → bound model class
  name) so route model bindings are introspectable.
- The MCP endpoint exposes the bundle as the `guren_entity_context` tool
  and the `guren://context/{entity}` resource template.
