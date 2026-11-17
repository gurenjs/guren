CREATE TABLE "comments" (
	"id" serial PRIMARY KEY,
	"body" text NOT NULL,
	"post_id" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tags" (
	"id" serial PRIMARY KEY,
	"slug" text NOT NULL UNIQUE,
	"label" text DEFAULT 'untitled' NOT NULL,
	"weight" numeric(8,2),
	"active" boolean DEFAULT false NOT NULL,
	"meta" jsonb,
	"ref" uuid,
	"seen_on" date,
	"postId" integer,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "comments_post_id_index" ON "comments" ("post_id");--> statement-breakpoint
CREATE INDEX "tags_ref_index" ON "tags" ("ref");--> statement-breakpoint
CREATE INDEX "tags_label_weight_index" ON "tags" ("label","weight");--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_post_id_posts_id_fkey" FOREIGN KEY ("post_id") REFERENCES "posts"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "tags" ADD CONSTRAINT "tags_postId_posts_id_fkey" FOREIGN KEY ("postId") REFERENCES "posts"("id") ON DELETE SET NULL;