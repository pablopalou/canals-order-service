ALTER TABLE "orders" ADD COLUMN "reconciliation_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX "idempotency_keys_order_id_idx" ON "idempotency_keys" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "orders_pending_payment_updated_at_idx" ON "orders" USING btree ("updated_at") WHERE "orders"."status" = 'pending_payment';