ALTER TABLE "tasks" ADD COLUMN "deleted_at" bigint;
--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "deleted_by" text;
--> statement-breakpoint
CREATE INDEX "idx_tasks_deleted_at" ON "tasks" USING btree ("deleted_at");
