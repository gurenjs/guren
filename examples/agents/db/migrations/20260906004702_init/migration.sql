CREATE TABLE `agent_approvals` (
	`id` text PRIMARY KEY,
	`tool` text NOT NULL,
	`input` text NOT NULL,
	`fingerprint` text NOT NULL,
	`principal` text,
	`principal_key` text NOT NULL,
	`requested_at` text NOT NULL,
	`expires_at` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`resolved_at` text,
	`resolved_by` text,
	`consumed_at` text
);
--> statement-breakpoint
CREATE TABLE `api_tokens` (
	`id` text PRIMARY KEY,
	`name` text NOT NULL,
	`hashed_token` text NOT NULL UNIQUE,
	`user_id` integer NOT NULL,
	`abilities` text NOT NULL,
	`last_used_at` integer,
	`expires_at` integer,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk_api_tokens_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `tickets` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`title` text NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`name` text NOT NULL,
	`email` text NOT NULL UNIQUE,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `agent_approvals_match_idx` ON `agent_approvals` (`tool`,`fingerprint`,`principal_key`);--> statement-breakpoint
CREATE INDEX `api_tokens_user_id_idx` ON `api_tokens` (`user_id`);--> statement-breakpoint
CREATE INDEX `tickets_status_idx` ON `tickets` (`status`);