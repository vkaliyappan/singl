CREATE TABLE `service_flows` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text DEFAULT 'Untitled flow' NOT NULL,
	`environment` text DEFAULT '' NOT NULL,
	`graph` text DEFAULT '{"nodes":[],"edges":[]}' NOT NULL,
	`createdAt` integer,
	`updatedAt` integer
);
