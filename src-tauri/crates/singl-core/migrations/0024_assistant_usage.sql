-- Token and cost record: one row per model call (API providers) or per CLI turn.
CREATE TABLE `assistant_usage` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `chatId` text NOT NULL,
  `messageId` text,
  `provider` text NOT NULL,
  `model` text NOT NULL DEFAULT '',
  `inputTokens` integer NOT NULL DEFAULT 0,
  `outputTokens` integer NOT NULL DEFAULT 0,
  `cacheReadTokens` integer NOT NULL DEFAULT 0,
  `cacheWriteTokens` integer NOT NULL DEFAULT 0,
  `costUsd` real,
  `createdAt` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `assistant_usage_chat_idx` ON `assistant_usage` (`chatId`);
--> statement-breakpoint
CREATE INDEX `assistant_usage_created_idx` ON `assistant_usage` (`createdAt`);
