CREATE TABLE `app_settings` (
	`id` integer PRIMARY KEY NOT NULL,
	`azurePatToken` text DEFAULT '' NOT NULL,
	`repoUrl` text DEFAULT '' NOT NULL,
	`clonedBranch` text DEFAULT '' NOT NULL,
	`repoSlug` text DEFAULT '' NOT NULL,
	`updatedAt` integer
);
