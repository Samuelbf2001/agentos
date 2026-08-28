CREATE TABLE `module_launches` (
	`id` text PRIMARY KEY NOT NULL,
	`module_id` text NOT NULL,
	`module_slug` text NOT NULL,
	`module_version` integer NOT NULL,
	`phase` text NOT NULL,
	`org_id` text NOT NULL,
	`project_id` text NOT NULL,
	`blueprint_snapshot` text NOT NULL,
	`blueprint_hash` text NOT NULL,
	`inputs` text NOT NULL,
	`inputs_digest` text NOT NULL,
	`toggles` text NOT NULL,
	`methodology_id` text NOT NULL,
	`result` text NOT NULL,
	`task_count` integer NOT NULL,
	`budget_phase_usd` real NOT NULL,
	`budget_per_run_usd` real NOT NULL,
	`previous_launch_id` text,
	`idempotency_key` text NOT NULL,
	`actor` text NOT NULL,
	`duration_ms` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`module_id`) REFERENCES `phase_modules`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`methodology_id`) REFERENCES `methodologies`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`previous_launch_id`) REFERENCES `module_launches`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_module_launches_idempotency` ON `module_launches` (`idempotency_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_module_launches_project_phase` ON `module_launches` (`project_id`,`phase`);--> statement-breakpoint
CREATE INDEX `idx_module_launches_module` ON `module_launches` (`module_id`);--> statement-breakpoint
CREATE TABLE `phase_modules` (
	`id` text PRIMARY KEY NOT NULL,
	`slug` text NOT NULL,
	`version` integer NOT NULL,
	`name` text NOT NULL,
	`phase` text NOT NULL,
	`project_type` text NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`methodology_slug` text NOT NULL,
	`methodology_version` integer,
	`blueprint` text NOT NULL,
	`blueprint_hash` text NOT NULL,
	`body_md` text NOT NULL,
	`changelog` text,
	`seed_file` text,
	`seed_hash` text,
	`created_by` text,
	`activated_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_phase_modules_slug_version` ON `phase_modules` (`slug`,`version`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_phase_modules_slug_active` ON `phase_modules` (`slug`) WHERE status = 'active';--> statement-breakpoint
CREATE INDEX `idx_phase_modules_phase_status` ON `phase_modules` (`phase`,`status`);--> statement-breakpoint
ALTER TABLE `tasks` ADD `depends_on` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `tasks` ADD `due_at` integer;