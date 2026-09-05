CREATE TABLE `notion_migration_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`source_schema_version` text NOT NULL,
	`captured_at` integer NOT NULL,
	`manifest_hash` text NOT NULL,
	`snapshot_run_id` text NOT NULL,
	`mode` text NOT NULL,
	`status` text DEFAULT 'running' NOT NULL,
	`report` text,
	`immutable` integer DEFAULT true NOT NULL,
	`started_at` integer NOT NULL,
	`finished_at` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_notion_migration_runs_snapshot` ON `notion_migration_runs` (`snapshot_run_id`);
--> statement-breakpoint
CREATE TABLE `notion_page_archives` (
	`id` text PRIMARY KEY NOT NULL,
	`migration_run_id` text NOT NULL,
	`source_kind` text NOT NULL,
	`notion_page_id` text NOT NULL,
	`original_url` text,
	`raw_page_uri` text,
	`raw_blocks_uri` text,
	`raw_comments_uri` text,
	`raw_files_uri` text,
	`payload` text NOT NULL,
	`payload_hash` text NOT NULL,
	`captured_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`migration_run_id`) REFERENCES `notion_migration_runs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_notion_page_archives_run_page` ON `notion_page_archives` (`migration_run_id`,`source_kind`,`notion_page_id`);
--> statement-breakpoint
CREATE INDEX `idx_notion_page_archives_page` ON `notion_page_archives` (`source_kind`,`notion_page_id`);
--> statement-breakpoint
CREATE TABLE `notion_import_links` (
	`id` text PRIMARY KEY NOT NULL,
	`migration_run_id` text NOT NULL,
	`source_kind` text NOT NULL,
	`notion_page_id` text NOT NULL,
	`agentos_object_kind` text NOT NULL,
	`agentos_object_id` text NOT NULL,
	`archive_id` text,
	`import_status` text NOT NULL,
	`source_last_edited_at` integer,
	`imported_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`migration_run_id`) REFERENCES `notion_migration_runs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`archive_id`) REFERENCES `notion_page_archives`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_notion_import_links_source` ON `notion_import_links` (`source_kind`,`notion_page_id`);
--> statement-breakpoint
CREATE INDEX `idx_notion_import_links_object` ON `notion_import_links` (`agentos_object_kind`,`agentos_object_id`);
--> statement-breakpoint
CREATE INDEX `idx_notion_import_links_run` ON `notion_import_links` (`migration_run_id`);
--> statement-breakpoint
CREATE TABLE `notion_identity_mappings` (
	`id` text PRIMARY KEY NOT NULL,
	`migration_run_id` text NOT NULL,
	`notion_person_id` text NOT NULL,
	`notion_email` text,
	`agentos_person_id` text,
	`match_method` text NOT NULL,
	`validation_state` text DEFAULT 'pending_review' NOT NULL,
	`reviewed_by` text,
	`reviewed_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`migration_run_id`) REFERENCES `notion_migration_runs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`agentos_person_id`) REFERENCES `people`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_notion_identity_mappings_person` ON `notion_identity_mappings` (`notion_person_id`);
--> statement-breakpoint
CREATE TABLE `notion_import_quarantine` (
	`id` text PRIMARY KEY NOT NULL,
	`migration_run_id` text NOT NULL,
	`source_kind` text NOT NULL,
	`notion_page_id` text NOT NULL,
	`field_name` text NOT NULL,
	`reason` text NOT NULL,
	`raw_reference` text,
	`resolution_state` text DEFAULT 'open' NOT NULL,
	`resolved_by` text,
	`resolved_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`migration_run_id`) REFERENCES `notion_migration_runs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_notion_import_quarantine_entry` ON `notion_import_quarantine` (`migration_run_id`,`source_kind`,`notion_page_id`,`field_name`,`raw_reference`);
--> statement-breakpoint
CREATE INDEX `idx_notion_import_quarantine_state` ON `notion_import_quarantine` (`resolution_state`,`reason`);
