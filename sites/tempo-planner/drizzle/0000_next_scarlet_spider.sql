CREATE TABLE `tempo_sync_accounts` (
	`user_id` text PRIMARY KEY NOT NULL,
	`revision` integer DEFAULT 0 NOT NULL,
	`state` text NOT NULL,
	`updated_at` text,
	`last_operation_id` text
);
--> statement-breakpoint
CREATE TABLE `tempo_sync_history` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`payload` text NOT NULL,
	`created_at` text NOT NULL,
	`expires_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `tempo_sync_history_user_created_idx` ON `tempo_sync_history` (`user_id`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `tempo_sync_history_expiry_idx` ON `tempo_sync_history` (`user_id`,`expires_at`);--> statement-breakpoint
CREATE TABLE `tempo_sync_operations` (
	`user_id` text NOT NULL,
	`id` text NOT NULL,
	`kind` text NOT NULL,
	`request_hash` text NOT NULL,
	`revision` integer NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`user_id`, `id`)
);
--> statement-breakpoint
CREATE INDEX `tempo_sync_operations_retention_idx` ON `tempo_sync_operations` (`user_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `tempo_sync_snapshots` (
	`user_id` text NOT NULL,
	`revision` integer NOT NULL,
	`state` text NOT NULL,
	`updated_at` text,
	`operation_id` text,
	`created_at` text NOT NULL,
	PRIMARY KEY(`user_id`, `revision`)
);
--> statement-breakpoint
CREATE INDEX `tempo_sync_snapshots_retention_idx` ON `tempo_sync_snapshots` (`user_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `tempo_sync_tombstones` (
	`user_id` text NOT NULL,
	`collection` text NOT NULL,
	`entity_id` text NOT NULL,
	`revision` integer NOT NULL,
	`deleted_at` text NOT NULL,
	PRIMARY KEY(`user_id`, `collection`, `entity_id`)
);
--> statement-breakpoint
CREATE INDEX `tempo_sync_tombstones_retention_idx` ON `tempo_sync_tombstones` (`user_id`,`deleted_at`);