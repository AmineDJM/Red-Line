ALTER TABLE "data_revisions" ADD COLUMN "map_version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "games" ADD COLUMN "map_version" integer DEFAULT 1 NOT NULL;