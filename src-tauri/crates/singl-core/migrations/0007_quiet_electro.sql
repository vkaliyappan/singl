CREATE TABLE `twx_service_presets` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`environment` text NOT NULL,
	`entityType` text NOT NULL,
	`entityName` text NOT NULL,
	`serviceName` text NOT NULL,
	`inputs` text DEFAULT '{}' NOT NULL,
	`output` text DEFAULT '' NOT NULL,
	`outputType` text DEFAULT '' NOT NULL,
	`createdAt` integer,
	`updatedAt` integer
);
