ALTER TABLE `app_settings` ADD `repoUrl` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `app_settings` ADD `clonedBranch` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `app_settings` ADD `repoSlug` text DEFAULT '' NOT NULL;
