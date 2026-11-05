CREATE TABLE `boards` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text DEFAULT 'Untitled board' NOT NULL,
	`scene` text DEFAULT '{"shapes":[]}' NOT NULL,
	`createdAt` integer,
	`updatedAt` integer
);
