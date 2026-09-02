import { buildApp } from "./app.js";
import { createServiceRoleSupabaseClient } from "./ingestion/supabase-event-repository.js";
import { createSupabaseEnqueueEvent } from "./ingestion/supabase-queue-repository.js";
import {
  createSupabaseApiKeyAuthDeps,
  createTouchApiKeyLastUsedAt,
} from "./auth/supabase-api-key-repository.js";
import {
  createInMemoryRateLimitStore,
  DEFAULT_INGESTION_RATE_LIMIT_CONFIG,
} from "./rate-limit/rate-limiter.js";
import { startRealWorkerLoop } from "./worker.js";

const PORT = Number(process.env.PORT ?? 8787);
const HOST = process.env.HOST ?? "0.0.0.0";
// Issue 7.3 judgment call (see worker.ts's own header comment for the
// full reasoning): the queue worker runs in this same process by
// default, alongside the HTTP server, rather than requiring a second
// Railway service for V1. Set WORKER_ENABLED=false on this service's
// variables if/when the worker is later split out to run as its own
// service via `pnpm --filter @volar/proxy start:worker` instead.
const WORKER_ENABLED = (process.env.WORKER_ENABLED ?? "true") !== "false";

// Issue 6.2: real API-key auth needs a real DB client. Constructed here
// (not inside app.ts/buildApp) so buildApp() stays testable without
// real Supabase credentials -- see BuildAppDeps's doc comment in
// app.ts. createServiceRoleSupabaseClient() throws immediately if
// SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY are missing, so a
// misconfigured deployment fails loudly at startup rather than on the
// first request.
const supabase = createServiceRoleSupabaseClient();

// Issue 6.5: rate-limit state is in-memory (see rate-limiter.ts's
// header comment for why -- no shared store exists until Epic 7's
// queue work lands), so it's constructed once here, for this
// process's lifetime, exactly like the app itself.
const app = buildApp({
  events: {
    authApiKeyDeps: createSupabaseApiKeyAuthDeps(supabase),
    touchLastUsedAt: createTouchApiKeyLastUsedAt(supabase),
    // Issue 7.2: enqueues onto pgmq.q_ingestion_events (issue 7.1) via
    // the public.enqueue_ingestion_event() RPC wrapper.
    enqueueEvent: createSupabaseEnqueueEvent(supabase),
    rateLimit: {
      store: createInMemoryRateLimitStore(),
      config: DEFAULT_INGESTION_RATE_LIMIT_CONFIG,
    },
  },
});

app
  .listen({ port: PORT, host: HOST })
  .then(() => {
    app.log.info(`volar-proxy listening on http://${HOST}:${PORT}`);
  })
  .catch((err) => {
    app.log.error(err);
    process.exit(1);
  });

// Issue 7.3: start the queue worker loop in-process, after the HTTP
// server is listening -- an async loop awaiting real I/O (Supabase RPC
// calls) between iterations yields the event loop just like any other
// pending request, so it does not block the server from handling
// traffic. Not awaited: this call returns immediately once the loop has
// been kicked off (see startWorkerLoop's own doc comment) -- it runs
// for the lifetime of the process, same as app.listen() above.
if (WORKER_ENABLED) {
  const workerHandle = startRealWorkerLoop();

  const shutdownWorker = () => {
    workerHandle.stop();
  };
  process.on("SIGTERM", shutdownWorker);
  process.on("SIGINT", shutdownWorker);
} else {
  app.log.info("WORKER_ENABLED=false -- queue worker not started in this process");
}
