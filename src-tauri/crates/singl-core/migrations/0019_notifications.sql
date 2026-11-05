CREATE TABLE `notifications` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`body` text DEFAULT '' NOT NULL,
	`url` text DEFAULT '/' NOT NULL,
	`tag` text,
	`refType` text,
	`refId` text,
	`readAt` integer,
	`createdAt` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `notifications_created_at` ON `notifications` (`createdAt`);