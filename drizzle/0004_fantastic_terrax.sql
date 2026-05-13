CREATE TABLE `twx_projects` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`environment` text NOT NULL,
	`projectName` text NOT NULL,
	`alias` text DEFAULT '' NOT NULL,
	`exports` text DEFAULT '["all"]' NOT NULL,
	`createdAt` integer,
	`updatedAt` integer
);
--> statement-breakpoint
ALTER TABLE `app_settings` ADD `twxRootPrefix` text DEFAULT 'WindchillClients/Thingworx' NOT NULL;--> statement-breakpoint
ALTER TABLE `app_settings` ADD `repoRootSubpath` text DEFAULT '' NOT NULL;