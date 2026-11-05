CREATE TABLE `flow_folders` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text DEFAULT 'New folder' NOT NULL,
	`parentId` text,
	`createdAt` integer,
	`updatedAt` integer
);
--> statement-breakpoint
ALTER TABLE `service_flows` ADD `folderId` text;