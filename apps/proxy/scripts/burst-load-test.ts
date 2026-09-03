// Issue 7.5 (Epic 7): load-test entrypoint. Deliberately a thin
// launcher, not where any real logic lives -- everything with actual
// behavior is under src/load-test/ (cli.ts and its collaborators),
// covered by apps/proxy's normal lint/typecheck/test (tsconfig.json's
// "include": ["src"]). This file lives outside that include on
// purpose: it's an operational script, not part of the deployed app
// (dist/index.js), so it isn't compiled into the production build --
// run directly via tsx instead. See src/load-test/cli.ts's header
// comment for required environment variables and usage.
import { runCli } from "../src/load-test/cli.js";

runCli(process.argv.slice(2)).catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
