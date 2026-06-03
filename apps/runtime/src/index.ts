import { serve } from "@hono/node-server";
import { loadConfig } from "./agent/config.js";
import { createServer } from "./server.js";

const config = loadConfig();
const app = createServer({ config, version: process.env.npm_package_version });

const server = serve({ fetch: app.fetch, port: config.port, hostname: config.hostname }, (info) => {
  console.log(`runtime listening on http://${config.hostname}:${info.port}`);
});

const shutdown = (): void => {
  server.close(() => process.exit(0));
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
