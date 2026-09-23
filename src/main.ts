import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";

const { server, activity } = createServer();

// Leave the activity registry clean when the session ends; a crash is caught later by the dead-pid check.
let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  await activity.close().catch(() => undefined);
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
process.stdin.on("close", shutdown);

await server.connect(new StdioServerTransport());
