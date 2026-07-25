CREATE TABLE `oauth_states` (
	`state_hash` text PRIMARY KEY,
	`provider` text NOT NULL,
	`redirect_to` text,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `posts` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`slug` text NOT NULL UNIQUE,
	`title` text NOT NULL,
	`description` text,
	`body_markdown` text NOT NULL,
	`body_html` text NOT NULL,
	`published_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY,
	`data` text NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`name` text NOT NULL,
	`email` text NOT NULL UNIQUE,
	`password_hash` text,
	`remember_token` text,
	`github_id` text UNIQUE,
	`created_at` integer NOT NULL
);
