import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
export default defineConfig({
  plugins: [{
    // Wrangler bundles src/ui.html as a text module; do the same in tests.
    name: "html-as-text",
    enforce: "pre",
    transform(code, id) { if (id.endsWith(".html")) return { code: `export default ${JSON.stringify(code)};`, map: null }; },
  }],
  resolve: { alias: { "cloudflare:workers": fileURLToPath(new URL("./test/support/cloudflare-workers.ts", import.meta.url)) } },
  test: {
    include: ["test/**/*.test.ts"], environment: "node",
    // These import cloudflare:workers themselves, so they must go through the alias above.
    server: { deps: { inline: ["agents", "@cloudflare/workers-oauth-provider"] } },
  },
});
