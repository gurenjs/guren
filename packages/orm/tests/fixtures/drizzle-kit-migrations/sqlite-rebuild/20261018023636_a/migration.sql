CREATE TABLE `posts` (
	`id` integer PRIMARY KEY,
	`title` text,
	`user_id` integer
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` integer PRIMARY KEY,
	`name` text
);
