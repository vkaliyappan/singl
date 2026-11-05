CREATE TABLE `todo_statuses` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`color` text DEFAULT '#6B7280' NOT NULL,
	`closed` integer DEFAULT false NOT NULL,
	`sortOrder` integer DEFAULT 0 NOT NULL,
	`createdAt` integer,
	`updatedAt` integer
);
--> statement-breakpoint
-- Default board. The first three ids are the status values todos already use.
INSERT INTO `todo_statuses` (`id`, `name`, `color`, `closed`, `sortOrder`, `createdAt`, `updatedAt`) VALUES
	('todo', 'To do', '#6B7280', 0, 0, unixepoch(), unixepoch()),
	('in-progress', 'In progress', '#F59E0B', 0, 1, unixepoch(), unixepoch()),
	('blocked', 'Blocked', '#EF4444', 0, 2, unixepoch(), unixepoch()),
	('done', 'Done', '#10B981', 1, 3, unixepoch(), unixepoch()),
	('cancelled', 'Cancelled', '#94A3B8', 1, 4, unixepoch(), unixepoch());
