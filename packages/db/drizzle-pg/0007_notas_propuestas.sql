ALTER TABLE "canvas_notes" ADD COLUMN "proposals" jsonb DEFAULT '[]'::jsonb NOT NULL;
