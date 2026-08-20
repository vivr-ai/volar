import { buildApp } from "./app.js";
import { createServiceRoleSupabaseClient } from "./ingestion/supabase-event-repository.js";
import { createSupabaseApiKeyAuthDeps } from "./auth/supabase-api-key-repository.js";
import {
  createInMemoryRateLimitStore,
  DEFAULT_INGESTION_RATE_LIMIT_CONFIG,
} from "./rate-limit/rate-limiter.js";

const PORT = Number(process.env.PORT ?? 8787);
const HOST = process.env.HOST ?? "0.0.0.0";

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
