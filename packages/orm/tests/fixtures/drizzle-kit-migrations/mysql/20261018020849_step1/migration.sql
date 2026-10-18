CREATE TABLE `posts` (
	`id` serial PRIMARY KEY,
	`title` text
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` serial PRIMARY KEY,
	`name` text NOT NULL,
	`age` int,
	`email` varchar(255),
	`bio` text
);
