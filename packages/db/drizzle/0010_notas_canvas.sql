CREATE TABLE `canvas_notes` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text,
	`project_id` text,
	`title` text NOT NULL,
	`scene` text NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`image_artifact_id` text,
	`image_path` text,
	`image_bytes` integer,
	`captured_at` integer,
	`transcription` text,
	`created_by_person_id` text,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`image_artifact_id`) REFERENCES `artifacts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by_person_id`) REFERENCES `people`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_canvas_notes_project` ON `canvas_notes` (`project_id`);
--> statement-breakpoint
CREATE INDEX `idx_canvas_notes_org` ON `canvas_notes` (`org_id`);
--> statement-breakpoint
CREATE INDEX `idx_canvas_notes_updated` ON `canvas_notes` (`updated_at`);
