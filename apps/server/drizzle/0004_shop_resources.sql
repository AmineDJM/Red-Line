CREATE TABLE "shop_resource_offers" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"money" double precision DEFAULT 0 NOT NULL,
	"resources" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"price" integer NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"sort" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "wallet_ledger" DROP CONSTRAINT "wallet_ledger_reason_check";--> statement-breakpoint
ALTER TABLE "wallet_ledger" ADD CONSTRAINT "wallet_ledger_reason_check" CHECK ("wallet_ledger"."reason" in ('purchase','accelerate','cosmetic','refund','admin','resources'));