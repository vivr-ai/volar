import { buildApp } from "./app.js";
import { createServiceRoleSupabaseClient } from "./ingestion/supabase-event-repository.js";
import { createSupabaseApiKeyAuthDeps } from "./auth/supabase-api-key-repository.js";

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

const app = buildApp({
  events: { authApiKeyDeps: createSupabaseApiKeyAuthDeps(supabase) },
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
