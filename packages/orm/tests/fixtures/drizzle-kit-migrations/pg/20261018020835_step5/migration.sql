ALTER TABLE "users" ADD COLUMN "nick" text;--> statement-breakpoint
CREATE INDEX "users_age_idx" ON "users" ("age");