CREATE TABLE `project_sources` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`kind` text NOT NULL,
	`external_ref` text NOT NULL,
	`status` text DEFAULT 'linked' NOT NULL,
	`knowledge_doc_id` text,
	`last_error` text,
	`last_ingested_at` integer,
	`created_by` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`knowledge_doc_id`) REFERENCES `knowledge_docs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_project_sources_project` ON `project_sources` (`project_id`,`kind`);