-- UI tests: AI-driven browser test suites and their cases (Azure DevOps test case layout).
CREATE TABLE `ui_test_suites` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`envId` text DEFAULT '' NOT NULL,
	`provider` text DEFAULT '' NOT NULL,
	`model` text DEFAULT '' NOT NULL,
	`mode` text DEFAULT 'headless' NOT NULL,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL
);
CREATE TABLE `ui_test_cases` (
	`id` text PRIMARY KEY NOT NULL,
	`suiteId` text NOT NULL REFERENCES `ui_test_suites`(`id`) ON DELETE CASCADE,
	`position` integer DEFAULT 0 NOT NULL,
	`adoId` integer,
	`title` text NOT NULL,
	`areaPath` text DEFAULT '' NOT NULL,
	`assignedTo` text DEFAULT '' NOT NULL,
	`state` text DEFAULT '' NOT NULL,
	`tags` text DEFAULT '' NOT NULL,
	`mode` text DEFAULT '' NOT NULL,
	`steps` text DEFAULT '[]' NOT NULL,
	`status` text DEFAULT 'notRun' NOT NULL,
	`reason` text DEFAULT '' NOT NULL,
	`stepResults` text DEFAULT '[]' NOT NULL,
	`chatId` text DEFAULT '' NOT NULL,
	`lastRunAt` integer,
	`durationMs` integer,
	`updatedAt` integer NOT NULL
);
CREATE INDEX `ui_test_cases_suite` ON `ui_test_cases` (`suiteId`, `position`);
