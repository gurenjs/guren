CREATE TABLE `search_index_state` (
	`id` integer PRIMARY KEY,
	`build_id` text NOT NULL,
	`previous_build_id` text,
	`updated_at` integer NOT NULL,
	CONSTRAINT "search_index_state_single_row" CHECK("id" = 1)
);
