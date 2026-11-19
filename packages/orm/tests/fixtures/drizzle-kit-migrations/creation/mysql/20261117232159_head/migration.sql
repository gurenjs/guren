CREATE TABLE `comments` (
	`id` int AUTO_INCREMENT PRIMARY KEY,
	`body` text NOT NULL,
	`post_id` int NOT NULL,
	`created_at` timestamp NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);
--> statement-breakpoint
CREATE TABLE `tags` (
	`id` int AUTO_INCREMENT PRIMARY KEY,
	`slug` varchar(255) NOT NULL,
	`label` varchar(255) NOT NULL DEFAULT 'untitled',
	`weight` decimal(8,2),
	`active` boolean NOT NULL DEFAULT false,
	`meta` json,
	`ref` varchar(36),
	`seen_on` date,
	`postId` int,
	`createdAt` timestamp NOT NULL DEFAULT (CURRENT_TIMESTAMP),
	CONSTRAINT `slug_unique` UNIQUE INDEX(`slug`)
);
--> statement-breakpoint
CREATE INDEX `comments_post_id_index` ON `comments` (`post_id`);--> statement-breakpoint
CREATE INDEX `tags_ref_index` ON `tags` (`ref`);--> statement-breakpoint
CREATE INDEX `tags_label_weight_index` ON `tags` (`label`,`weight`);--> statement-breakpoint
ALTER TABLE `comments` ADD CONSTRAINT `comments_post_id_posts_id_fkey` FOREIGN KEY (`post_id`) REFERENCES `posts`(`id`) ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE `tags` ADD CONSTRAINT `tags_postId_posts_id_fkey` FOREIGN KEY (`postId`) REFERENCES `posts`(`id`) ON DELETE SET NULL;