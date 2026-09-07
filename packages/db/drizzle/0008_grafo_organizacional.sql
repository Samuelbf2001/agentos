CREATE TABLE `org_units` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`name` text NOT NULL,
	`parent_unit_id` text,
	`description` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`parent_unit_id`) REFERENCES `org_units`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_org_units_org` ON `org_units` (`org_id`);
--> statement-breakpoint
CREATE TABLE `org_roles` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`unit_id` text,
	`name` text NOT NULL,
	`purpose` text,
	`reports_to_role_id` text,
	`canvas_x` real,
	`canvas_y` real,
	`status` text DEFAULT 'draft' NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`unit_id`) REFERENCES `org_units`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`reports_to_role_id`) REFERENCES `org_roles`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_org_roles_org` ON `org_roles` (`org_id`);
--> statement-breakpoint
CREATE INDEX `idx_org_roles_unit` ON `org_roles` (`unit_id`);
--> statement-breakpoint
CREATE TABLE `role_functions` (
	`id` text PRIMARY KEY NOT NULL,
	`role_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`position` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`role_id`) REFERENCES `org_roles`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_role_functions_role` ON `role_functions` (`role_id`);
--> statement-breakpoint
CREATE TABLE `role_people` (
	`role_id` text NOT NULL,
	`person_id` text NOT NULL,
	`dedication_pct` integer,
	`created_at` integer NOT NULL,
	PRIMARY KEY (`role_id`, `person_id`),
	FOREIGN KEY (`role_id`) REFERENCES `org_roles`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`person_id`) REFERENCES `people`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `role_processes` (
	`role_id` text NOT NULL,
	`process_id` text NOT NULL,
	`relation` text DEFAULT 'participant' NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY (`role_id`, `process_id`),
	FOREIGN KEY (`role_id`) REFERENCES `org_roles`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`process_id`) REFERENCES `processes`(`id`) ON UPDATE no action ON DELETE no action
);
