CREATE TABLE "task_assignees" (
	"task_id" text NOT NULL,
	"person_id" text NOT NULL,
	"is_primary" boolean DEFAULT false NOT NULL,
	"assigned_by" text NOT NULL,
	"created_at" bigint NOT NULL,
	CONSTRAINT "pk_task_assignees" PRIMARY KEY ("task_id", "person_id"),
	CONSTRAINT "task_assignees_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "task_assignees_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX "uq_task_assignees_task_person" ON "task_assignees" USING btree ("task_id","person_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "uq_task_assignees_task_primary" ON "task_assignees" USING btree ("task_id") WHERE is_primary = true;
--> statement-breakpoint
CREATE INDEX "idx_task_assignees_task" ON "task_assignees" USING btree ("task_id");
--> statement-breakpoint
CREATE INDEX "idx_task_assignees_person" ON "task_assignees" USING btree ("person_id");
--> statement-breakpoint
CREATE TABLE "task_notification_log" (
	"id" text PRIMARY KEY NOT NULL,
	"task_id" text NOT NULL,
	"person_id" text NOT NULL,
	"kind" text NOT NULL,
	"scheduled_at" bigint NOT NULL,
	"delivered_at" bigint,
	"status" text DEFAULT 'pending' NOT NULL,
	"dedupe_key" text NOT NULL,
	"last_error" text,
	"created_at" bigint NOT NULL,
	CONSTRAINT "task_notification_log_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "task_notification_log_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX "uq_task_notification_log_dedupe" ON "task_notification_log" USING btree ("dedupe_key");
--> statement-breakpoint
CREATE INDEX "idx_task_notification_log_pending" ON "task_notification_log" USING btree ("status","scheduled_at");
--> statement-breakpoint
CREATE INDEX "idx_task_notification_log_task" ON "task_notification_log" USING btree ("task_id","person_id");
--> statement-breakpoint
INSERT INTO "task_assignees" ("task_id", "person_id", "is_primary", "assigned_by", "created_at")
SELECT "id", "assignee_person_id", true, 'system:migration:0005', "created_at"
FROM "tasks"
WHERE "assignee_person_id" IS NOT NULL
ON CONFLICT ("task_id", "person_id") DO NOTHING;
