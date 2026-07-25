# Glossary

Short definitions for common terms in the Guren docs.

## Stack
- **Bun**: JavaScript/TypeScript runtime used to run and build the app.
- **Hono**: Lightweight HTTP server; Guren builds its routing and controllers on top.
- **Inertia.js**: Bridges server responses and SPA navigation by sending page props.
- **React**: UI library used for pages.
- **Vite**: Frontend dev server and build tool.
- **Drizzle ORM**: Type-safe ORM; Guren models connect to Drizzle schemas.

## App structure
- **MVC**: Model, View, Controller separation.
- **Route**: A path + HTTP method mapping to a controller or handler.
- **Controller**: Class that handles requests and returns responses.
- **Model**: Class tied to a database table via `static table`.
- **View**: React page in `resources/js/pages/`.
- **Middleware**: Code that runs before or after a request.
- **Provider**: Boot-time registration for services and configuration.
- **Context**: Hono `Context` with request and response helpers.

## Database
- **ORM**: Maps tables to classes.
- **Schema**: Table definitions in `db/schema.ts`.
- **Migration**: SQL files that apply schema changes.
- **Seeder**: Script to insert sample data.
- **Database URL**: Connection string in `.env` as `DATABASE_URL`.
- **RQB (Relational Query Builder)**: Drizzle query builder for joins and aggregates.
- **Eager load**: Fetch related records in one go (e.g. `with()`).

## Frontend
- **SPA**: Single page app navigation without full reloads.
- **SSR**: Server-side rendering for the first HTML response.
- **Props**: Data passed to React components.
- **HMR**: Hot reload of frontend changes during development, handled by Vite. Backend changes need a dev-server restart.
- **Inertia page**: A React component referenced by `this.inertia(...)`.

## CLI
- **create-guren-app**: CLI to scaffold a new app.
- **guren CLI**: `bunx guren make:*` commands for generators and tooling.

## Start here
- [First Steps](./first-steps.md)
- [Getting Started](./getting-started.md)
