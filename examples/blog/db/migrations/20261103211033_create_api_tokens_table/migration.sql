CREATE TABLE "api_tokens" (
	"id" text PRIMARY KEY,
	"name" text NOT NULL,
	"hashed_token" text NOT NULL UNIQUE,
	"user_id" text NOT NULL,
	"abilities" jsonb NOT NULL,
	"last_used_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
