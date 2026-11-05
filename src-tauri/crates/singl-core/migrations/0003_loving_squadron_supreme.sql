CREATE TABLE `repo_settings` (
	`id` integer PRIMARY KEY NOT NULL,
	`repoUrl` text DEFAULT '' NOT NULL,
	`clonedBranch` text DEFAULT '' NOT NULL,
	`repoSlug` text DEFAULT '' NOT NULL,
	`updatedAt` integer
);
--> statement-breakpoint
ALTER TABLE `app_settings` DROP COLUMN `repoUrl`;--> statement-breakpoint
ALTER TABLE `app_settings` DROP COLUMN `clonedBranch`;--> statement-breakpoint
ALTER TABLE `app_settings` DROP COLUMN `repoSlug`;