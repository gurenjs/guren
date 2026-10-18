CREATE TABLE `posts` (
	`id` integer PRIMARY KEY,
	`title` text
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`name` text NOT NULL,
	`age` integer,
	`email` text,
	`bio` text
);
