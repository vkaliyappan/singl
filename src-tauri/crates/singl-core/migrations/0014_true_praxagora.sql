CREATE TABLE `assistant_chats` (
	`id` text PRIMARY KEY NOT NULL,
	`scope` text NOT NULL,
	`domain` text DEFAULT 'general' NOT NULL,
	`title` text DEFAULT 'New chat' NOT NULL,
	`messages` text DEFAULT '[]' NOT NULL,
	`messageCount` integer DEFAULT 0 NOT NULL,
	`createdAt` integer,
	`updatedAt` integer
);
--> statement-breakpoint
CREATE INDEX `assistant_chats_scope_updated` ON `assistant_chats` (`scope`,`updatedAt`);