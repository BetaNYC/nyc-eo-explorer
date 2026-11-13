import { defineConfig } from "vitest/config";

// Node environment on purpose: everything under test is a pure function.
// Nothing here touches the DOM, React, or DuckDB.
export default defineConfig({
  // The one exception: test/whats-changed.test.js renders the small SiteFooter
  // component to check its link. The app is built with React's automatic JSX
  // runtime (@vitejs/plugin-react); this gives the tests the same transform.
  esbuild: { jsx: "automatic" },
  test: {
    environment: "node",
    include: ["test/**/*.test.js"],
  },
});
