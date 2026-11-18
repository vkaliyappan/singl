CREATE TABLE `entity_snapshots` (
	`id` text PRIMARY KEY NOT NULL,
	`chatId` text,
	`callId` text NOT NULL,
	`seq` integer NOT NULL,
	`tool` text NOT NULL,
	`path` text NOT NULL,
	`newPath` text,
	`beforeKind` text NOT NULL,
	`beforeHash` text,
	`beforeContent` blob,
	`afterKind` text NOT NULL,
	`afterHash` text,
	`createdAt` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `entity_snapshots_call` ON `entity_snapshots` (`callId`);
--> statement-breakpoint
CREATE INDEX `entity_snapshots_created` ON `entity_snapshots` (`createdAt`);
