ALTER TABLE "games" ADD COLUMN "unranked" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "unlimited" boolean DEFAULT false NOT NULL;--> statement-breakpoint
-- Mode illimité d'office pour les super-administrateurs existants (compte ADMIN_EMAIL).
UPDATE "users" SET "unlimited" = true WHERE "role" = 'superadmin';