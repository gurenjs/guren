PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_posts` (
	`id` integer PRIMARY KEY,
	`title` text DEFAULT 'untitled',
	`user_id` integer
);
--> statement-breakpoint
INSERT INTO `__new_posts`(`id`, `title`, `user_id`) SELECT `id`, `title`, `user_id` FROM `posts`;--> statement-breakpoint
DROP TABLE `posts`;--> statement-breakpoint
ALTER TABLE `__new_posts` RENAME TO `posts`;--> statement-breakpoint
PRAGMA foreign_keys=ON;