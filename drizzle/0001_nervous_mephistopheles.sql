CREATE TABLE `avatar_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`cache_key` text NOT NULL,
	`active_key` text,
	`profile_url` text NOT NULL,
	`origin` text NOT NULL,
	`status` text NOT NULL,
	`storage_allowed` integer DEFAULT 0 NOT NULL,
	`snapshot` text,
	`result` text,
	`error` text,
	`created_at` integer NOT NULL,
	`submitted_at` integer,
	`ready_at` integer,
	`completed_at` integer,
	`next_check` integer DEFAULT 0 NOT NULL,
	`lease_until` integer DEFAULT 0 NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`submission_ms` integer,
	`scraping_ms` integer,
	`retrieval_ms` integer,
	`storage_ms` integer,
	`image_load_ms` integer,
	`cache_hit` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `avatar_jobs_active_key_unique` ON `avatar_jobs` (`active_key`);