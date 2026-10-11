import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // Modules read configuration at import time, so these have to exist before
    // any test file loads. They are fixtures, not real secrets.
    env: {
      MASTER_KEY: "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff",
      WALLET_PASSWORD: "test",
      // Unit tests mock the database. Set TEST_DATABASE_URL to also run the
      // integration tests in test/integration, which talk to a real Postgres;
      // without it they skip, so `npm test` needs nothing installed.
      DATABASE_URL:
        process.env.TEST_DATABASE_URL ?? "postgres://test:test@127.0.0.1:5432/does_not_connect",
    },
  },
});
