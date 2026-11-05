CREATE TABLE `app_settings` (
	`id` integer PRIMARY KEY NOT NULL,
	`azurePatToken` text DEFAULT '' NOT NULL,
	`updatedAt` integer
);