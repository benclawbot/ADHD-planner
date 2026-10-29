import { index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const syncAccounts = sqliteTable("tempo_sync_accounts", {
  userId: text("user_id").primaryKey(),
  revision: integer("revision").notNull().default(0),
  state: text("state").notNull(),
  updatedAt: text("updated_at"),
  lastOperationId: text("last_operation_id"),
  lastCommitToken: text("last_commit_token"),
});

export const syncSnapshots = sqliteTable("tempo_sync_snapshots", {
  userId: text("user_id").notNull(),
  revision: integer("revision").notNull(),
  state: text("state").notNull(),
  updatedAt: text("updated_at"),
  operationId: text("operation_id"),
  createdAt: text("created_at").notNull(),
}, (table) => [
  primaryKey({ columns: [table.userId, table.revision] }),
  index("tempo_sync_snapshots_retention_idx").on(table.userId, table.createdAt),
]);

export const syncHistory = sqliteTable("tempo_sync_history", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  payload: text("payload").notNull(),
  createdAt: text("created_at").notNull(),
  expiresAt: text("expires_at").notNull(),
}, (table) => [
  index("tempo_sync_history_user_created_idx").on(table.userId, table.createdAt, table.id),
  index("tempo_sync_history_expiry_idx").on(table.userId, table.expiresAt),
]);

export const syncOperations = sqliteTable("tempo_sync_operations", {
  userId: text("user_id").notNull(),
  id: text("id").notNull(),
  kind: text("kind").notNull(),
  requestHash: text("request_hash").notNull(),
  revision: integer("revision").notNull(),
  createdAt: text("created_at").notNull(),
}, (table) => [
  primaryKey({ columns: [table.userId, table.id] }),
  index("tempo_sync_operations_retention_idx").on(table.userId, table.createdAt),
]);

export const syncTombstones = sqliteTable("tempo_sync_tombstones", {
  userId: text("user_id").notNull(),
  collection: text("collection").notNull(),
  entityId: text("entity_id").notNull(),
  revision: integer("revision").notNull(),
  deletedAt: text("deleted_at").notNull(),
}, (table) => [
  primaryKey({ columns: [table.userId, table.collection, table.entityId] }),
  index("tempo_sync_tombstones_retention_idx").on(table.userId, table.deletedAt),
]);
