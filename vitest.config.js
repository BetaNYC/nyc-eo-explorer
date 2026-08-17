import { defineConfig } from "vitest/config";

// Node environment on purpose: everything under test is a pure function.
// Nothing here touches the DOM, React, or DuckDB.
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.js"],
  },
});
