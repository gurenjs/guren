ALTER TABLE `tickets` ADD `category` text;--> statement-breakpoint
ALTER TABLE `tickets` ADD `category_probability` real;--> statement-breakpoint
ALTER TABLE `tickets` ADD `triage` text DEFAULT 'pending' NOT NULL;