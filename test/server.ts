import { serve } from "bun";
import { readFileSync } from "fs";
import { join } from "path";

const html = readFileSync(join(import.meta.dir, "websocket.html"), "utf8");

serve({
  port: 8000,
  fetch(req) {
    return new Response(html, {
      headers: { "Content-Type": "text/html" },
    });
  },
});

console.log("Test server running at http://localhost:8000");
