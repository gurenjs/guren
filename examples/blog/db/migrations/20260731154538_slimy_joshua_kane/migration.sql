-- Existing rows hold a bare wall clock that was written as UTC: drizzle sends
-- `Date.toISOString()` and `timestamp without time zone` drops the offset. The
-- generated cast (`::timestamp with time zone`) would reinterpret that wall
-- clock against the session's TimeZone instead, so the USING clause names UTC
-- explicitly and the conversion no longer depends on who runs the migration.
ALTER TABLE "users" ALTER COLUMN "email_verified_at" SET DATA TYPE timestamp with time zone USING "email_verified_at" AT TIME ZONE 'UTC';
