import type { SupabaseClient } from "@supabase/supabase-js";
import type { DequeuedMessage } from "./queue-message.js";

// Issue 7.3: real Supabase-backed wiring for WorkerCycleDeps's
// dequeueMessages/archiveMessage -- thin and mechanical, same
// convention as every other *-repository.ts adapter in this codebase
// (supabase-queue-repository.ts for the enqueue side, etc.). Calls the
// two RPC wrappers from this issue's own migration
// (supabase/migrations/20260902090000_ingestion_queue_worker_wrappers.sql):
// public.dequeue_ingestion_events() and public.archive_ingestion_event()
// -- see that migration's header comment for why wrappers are needed at
// all (pgmq isn't exposed to PostgREST directly).

export interface WorkerQueueDeps {
  dequeueMessages: (
    visibilityTimeoutSeconds: number,
    batchSize: number,
  ) => Promise<DequeuedMessage[]>;
  archiveMessage: (msgId: number) => Promise<void>;
}

interface DequeueRowFromDb {
  msg_id: number;
  read_ct: number;
  enqueued_at: string;
  vt: string;
  message: unknown;
}

export function createSupabaseWorkerQueueDeps(supabase: SupabaseClient): WorkerQueueDeps {
  return {
    async dequeueMessages(visibilityTimeoutSeconds, batchSize): Promise<DequeuedMessage[]> {
      const { data, error } = await supabase.rpc("dequeue_ingestion_events", {
        visibility_timeout_seconds: visibilityTimeoutSeconds,
        batch_size: batchSize,
      });

      if (error) {
        throw new Error(`Failed to dequeue ingestion events: ${error.message}`);
      }

      return ((data ?? []) as DequeueRowFromDb[]).map((row) => ({
        msgId: row.msg_id,
        readCt: row.read_ct,
        enqueuedAt: row.enqueued_at,
        vt: row.vt,
        message: row.message,
      }));
    },

    async archiveMessage(msgId: number): Promise<void> {
      const { error } = await supabase.rpc("archive_ingestion_event", {
        target_msg_id: msgId,
      });

      if (error) {
        throw new Error(`Failed to archive ingestion event msg_id=${msgId}: ${error.message}`);
      }
    },
  };
}
