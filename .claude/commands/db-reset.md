# /db-reset - Reset Database

Reset the development database by stopping, starting, and re-seeding.

## Instructions

Run the following steps in order:

1. Stop the database container
2. Start a fresh database container
3. Wait for database to be ready
4. Run migrations
5. Run seeders

## Commands

```bash
bun run db:down && bun run db:up && sleep 3 && bun run db:migrate && bun run db:seed
```

## Notes

- This destroys all existing data in the development database
- The `sleep 3` ensures PostgreSQL is ready before migrations
- Runs against the `examples/blog` database

## On Failure

If reset fails:
1. Check if Docker is running
2. Check if port 54322 is available
3. Review migration errors if migrations fail
