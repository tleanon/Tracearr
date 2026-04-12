ALTER TABLE "server_users" ADD COLUMN "removed_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "server_users_removed_at_idx" ON "server_users" USING btree ("removed_at");