import { z } from "zod";

// Issue 7.3 (Epic 7): the shape of a message this worker reads back off
// pgmq.q_ingestion_events, and the runtime validator that re-checks it
// before trusting it.
//
// DequeuedMessage mirrors pgmq.message_record (see
// public.dequeue_ingestion_events's return shape, issue 7.3's own
// migration) -- msgId/readCt/enqueuedAt/vt are pgmq's own envelope
// fields; `message` is the raw jsonb payload issue 7.2 enqueued, still
// untyped here (`unknown`) until queuedEventMessageSchema below has
// actually checked it.
//
// Why re-validate at all, when issue 7.2 already validated the exact
// same shape before enqueueing: the queue is a real boundary between
// two independently-deployable pieces of code (the ingestion endpoint
// that writes messages, this worker that reads them), even though today
// they happen to ship from the same repo/release. Trusting a queue
// message's shape just because *some* producer validated it at some
// point in the past is the same class of mistake as trusting client
// input generally -- a future schema change, a manually inserted
// message (e.g. while debugging), or a partially-rolled-out deploy
// where an older producer and a newer worker briefly overlap could all
// put something unexpected on the queue. Re-validating here costs
// nothing at this volume and means a bad message is reported clearly
// (see process-queue-message.ts) instead of exploding deep inside
// writeLlmCallEvent with a confusing type error.
//
// Deliberately a separate schema from @volar/shared's
// ingestionEventPayloadSchema, not a reuse of it: that one validates
// the *wire* shape (snake_case, per FR-6.5, meant for the SDK/customer
// boundary and shared with future SDK packages). This one validates the
// *internal* shape (camelCase ValidatedEventPayload, per issue 5.2) that
// only ever exists between this proxy's own endpoint and its own
// worker -- an implementation detail of this one service, not a public
// contract, so it lives here in apps/proxy rather than packages/shared.

export interface DequeuedMessage {
  msgId: number;
  readCt: number;
  enqueuedAt: string;
  vt: string;
  message: unknown;
}

// Mirrors write-llm-call-event.ts's SupportedProvider/EventStatus
// literal unions -- kept as separate literals here (rather than an
// import) since those two types have no runtime representation to
// validate against; this is the one place that needs the values
// spelled out as an actual runtime check. If a provider/status is ever
// added there, it must be added here too.
export const QUEUE_SUPPORTED_PROVIDERS = ["openai", "anthropic"] as const;
export const QUEUE_SUPPORTED_STATUSES = ["success", "error"] as const;

export const queuedEventMessageSchema = z.object({
  eventId: z.string().min(1),
  projectId: z.string().min(1),
  provider: z.enum(QUEUE_SUPPORTED_PROVIDERS),
  model: z.string().min(1),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  customerId: z.string().min(1).nullable().optional(),
  featureId: z.string().min(1).nullable().optional(),
  // Always a plain string here, never a Date instance -- jsonb never
  // round-trips a JS Date, only whatever ISO string it was serialized
  // as when issue 7.2 enqueued it (see supabase-queue-repository.ts's
  // comment on the enqueue side making the same point).
  occurredAt: z.string().min(1),
  status: z.enum(QUEUE_SUPPORTED_STATUSES),
});

export type QueuedEventPayload = z.infer<typeof queuedEventMessageSchema>;
