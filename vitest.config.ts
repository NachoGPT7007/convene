// Build output must never be collected as tests: `npm run build` compiles test/ into dist/test/,
// and without this include pattern every test runs twice — once from source, once from a stale copy.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.{ts,mjs}'],
    exclude: ['node_modules/**', 'dist/**', 'apps/**'],
  },
});
