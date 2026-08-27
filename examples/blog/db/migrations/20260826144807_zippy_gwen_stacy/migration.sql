CREATE TABLE "attachments" (
	"id" text PRIMARY KEY,
	"attachable_type" text NOT NULL,
	"attachable_id" text NOT NULL,
	"collection" text DEFAULT 'default' NOT NULL,
	"disk" text NOT NULL,
	"path" text NOT NULL,
	"name" text NOT NULL,
	"content_type" text NOT NULL,
	"size" integer NOT NULL,
	"width" integer,
	"height" integer,
	"variants" jsonb,
	"placeholder" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "attachments_attachable_idx" ON "attachments" ("attachable_type","attachable_id","collection");