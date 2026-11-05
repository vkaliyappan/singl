CREATE TABLE `environment_settings` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`environment` text NOT NULL,
	`twxBaseUrl` text DEFAULT '' NOT NULL,
	`twxAppKey` text DEFAULT '' NOT NULL,
	`createdAt` integer,
	`updatedAt` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `environment_settings_environment_unique` ON `environment_settings` (`environment`);