import { buildApp } from "./app.js";

const PORT = Number(process.env.PORT ?? 8787);
const HOST = process.env.HOST ?? "0.0.0.0";

const app = buildApp();

app
  .listen({ port: PORT, host: HOST })
  .then(() => {
    app.log.info(`volar-proxy listening on http://${HOST}:${PORT}`);
  })
  .catch((err) => {
    app.log.error(err);
    process.exit(1);
  });
