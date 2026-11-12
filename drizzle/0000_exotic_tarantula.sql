CREATE TABLE `avatar_cache` (
	`key` text PRIMARY KEY NOT NULL,
	`payload` text NOT NULL,
	`expires` integer NOT NULL
);
