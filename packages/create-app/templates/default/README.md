# __APP_TITLE__

Welcome to your new Guren application.

## Getting Started

1. Install dependencies with `bun install`.
2. Copy `.env.example` to `.env` and update any required values.
3. Start the development server with `bun run dev`.

The default setup expects a PostgreSQL database. You can change the connection string in `config/database.ts` or set the `DATABASE_URL` environment variable before running the server.

## Available Scripts

- `bun run dev` - start the local development server.
- `bun run db:make` - scaffold a new SQL migration from your schema using drizzle-kit.
- `bun run db:migrate` - apply database migrations.
- `bun run db:seed` - execute seeders.

Happy hacking!
