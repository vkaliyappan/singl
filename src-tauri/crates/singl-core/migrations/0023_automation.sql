-- Automation: service test suites, run history (suites and drift reports), schedules.
CREATE TABLE `automation_suites` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`envs` text DEFAULT '[]' NOT NULL,
	`cases` text DEFAULT '[]' NOT NULL,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL
);
CREATE TABLE `automation_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`refId` text NOT NULL,
	`name` text NOT NULL,
	`status` text NOT NULL,
	`summary` text DEFAULT '' NOT NULL,
	`result` text NOT NULL,
	`startedAt` integer NOT NULL,
	`durationMs` integer DEFAULT 0 NOT NULL
);
CREATE INDEX `automation_runs_ref` ON `automation_runs` (`kind`, `refId`, `startedAt`);
CREATE TABLE `automation_schedules` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`enabled` integer DEFAULT 1 NOT NULL,
	`kind` text NOT NULL,
	`target` text NOT NULL,
	`utcOffsetMin` integer DEFAULT 0 NOT NULL,
	`lastRunAt` integer,
	`lastStatus` text,
	`lastMessage` text,
	`nextRunAt` integer,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL
);
