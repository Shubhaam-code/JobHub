import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    restoreMocks: true,
    clearMocks: true,
    /* Blocks `mongoose.connect`, so no test can reach the configured cluster.
       `MONGODB_URI` is the deployed database here, and a suite that connected to it
       once wiped the `jobs` collection on every run. See the file for the details. */
    setupFiles: ['tests/setup/no-live-database.ts'],
  },
});
