import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // The AI self-trap / head-to-head guards run many full 60 Hz matches with
    // the live scoring-loop bot (a heavier per-tick decision than the old
    // hierarchical tree). Each measurement test is a few seconds; give a
    // generous ceiling so they never flake under CI CPU contention while still
    // catching a genuine hang.
    testTimeout: 120000,
  },
});
