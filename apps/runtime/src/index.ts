import { serve } from "@hono/node-server";
import { loadConfig } from "./agent/config.js";
import { createServer } from "./server.js";
import { shutdownTelemetry, startTelemetry } from "./telemetry.js";

const config = loadConfig();
const version = process.env.npm_package_version;
const telemetryOn = startTelemetry(process.env, version);

const app = createServer({ config, version });

const server = serve({ fetch: app.fetch, port: config.port, hostname: config.hostname }, (info) => {
  console.log(
    `runtime listening on http://${config.hostname}:${info.port} (telemetry ${telemetryOn ? "on" : "off"})`,
  );
});

const shutdown = (): void => {
  server.close(() => {
    void shutdownTelemetry().finally(() => process.exit(0));
  });
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
