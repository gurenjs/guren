# /dev - Start Development Server

Start the development server for the blog example application.

## Instructions

1. Ensure the database is running (`bun run db:up` if needed)
2. Start the development server
3. The server will be available at http://localhost:3333

## Command

```bash
bun run dev
```

This starts the blog example with hot reloading enabled.

## Notes

- Changes to server code will auto-reload
- Frontend changes use Vite HMR
- Press Ctrl+C to stop the server

## Prerequisites

If the server fails to start:
1. Ensure database is running: `bun run db:up`
2. Ensure migrations are applied: `bun run db:migrate`
3. Ensure packages are built: `bun run build`
