CREATE TABLE `todos` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'todo' NOT NULL,
	`priority` text DEFAULT 'medium' NOT NULL,
	`sortOrder` integer DEFAULT 0 NOT NULL,
	`dueAt` integer,
	`remindAt` integer,
	`remindedAt` integer,
	`completedAt` integer,
	`createdAt` integer,
	`updatedAt` integer
);
--> statement-breakpoint
CREATE INDEX `todos_remind_at` ON `todos` (`remindAt`);