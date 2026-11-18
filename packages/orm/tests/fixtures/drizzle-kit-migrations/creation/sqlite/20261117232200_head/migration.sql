CREATE TABLE `comments` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`body` text NOT NULL,
	`post_id` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	CONSTRAINT `fk_comments_post_id_posts_id_fk` FOREIGN KEY (`post_id`) REFERENCES `posts`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `tags` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`slug` text NOT NULL UNIQUE,
	`label` text DEFAULT 'untitled' NOT NULL,
	`weight` numeric,
	`active` integer DEFAULT false NOT NULL,
	`meta` text,
	`ref` text,
	`seen_on` text,
	`postId` integer,
	`createdAt` integer DEFAULT (unixepoch()) NOT NULL,
	CONSTRAINT `fk_tags_postId_posts_id_fk` FOREIGN KEY (`postId`) REFERENCES `posts`(`id`) ON DELETE SET NULL
);
--> statement-breakpoint
CREATE INDEX `comments_post_id_index` ON `comments` (`post_id`);--> statement-breakpoint
CREATE INDEX `tags_ref_index` ON `tags` (`ref`);--> statement-breakpoint
CREATE INDEX `tags_label_weight_index` ON `tags` (`label`,`weight`);