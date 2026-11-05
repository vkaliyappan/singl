CREATE TABLE `assistant_sessions` (
	`chatId` text PRIMARY KEY NOT NULL,
	`provider` text NOT NULL,
	`model` text DEFAULT '' NOT NULL,
	`sessionId` text NOT NULL,
	`turnCount` integer NOT NULL,
	`turnsHash` text NOT NULL,
	`contextHash` text,
	`size` integer DEFAULT 0 NOT NULL,
	`updatedAt` integer
);
