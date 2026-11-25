-- Assistant memory: short facts the assistant chose to keep across chats.
CREATE TABLE `assistant_memories` (
	`id` text PRIMARY KEY NOT NULL,
	`text` text NOT NULL,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL
);
