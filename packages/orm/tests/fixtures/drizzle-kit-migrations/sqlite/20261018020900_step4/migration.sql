PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_users` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`name` text NOT NULL,
	`age` text,
	`email` text NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_users`(`id`, `name`, `age`, `email`) SELECT `id`, `name`, `age`, `email` FROM `users`;--> statement-breakpoint
DROP TABLE `users`;--> statement-breakpoint
ALTER TABLE `__new_users` RENAME TO `users`;--> statement-breakpoint
PRAGMA foreign_keys=ON;