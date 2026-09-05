CREATE TABLE "task_labels" (
	"task_id" text NOT NULL,
	"label" text NOT NULL,
	"created_by" text,
	"created_at" bigint NOT NULL,
	CONSTRAINT "pk_task_labels" PRIMARY KEY ("task_id", "label"),
	CONSTRAINT "task_labels_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action
);
--> statement-breakpoint
CREATE INDEX "idx_task_labels_label" ON "task_labels" USING btree ("label");
--> statement-breakpoint
CREATE INDEX "idx_task_labels_task" ON "task_labels" USING btree ("task_id");
