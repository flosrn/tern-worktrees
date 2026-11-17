import { defineConfig } from 'vite-plus';

const envSet = (name: string): boolean => {
  const value = process.env[name];
  return value !== undefined && value !== '';
};

const reporters = (): string[] => {
  if (envSet('STRYKER_MUTATOR_WORKER')) {
    return ['dot'];
  }
  if (envSet('GITHUB_ACTIONS')) {
    return ['default', 'github-actions'];
  }
  return ['default'];
};

export default defineConfig({
  test: {
    coverage: {
      exclude: ['src/bin.ts'],
      ignoreClassMethods: ['constructor'],
      include: ['src/**/*.ts'],
      provider: 'v8',
      reportOnFailure: true,
      reporter: ['text', 'json-summary', 'json'],
      thresholds: {
        branches: 100,
        functions: 100,
        lines: 100,
        statements: 100,
      },
    },
    // Local runs share a Mac with other agents. CI keeps the Vitest default.
    // VITEST_MAX_WORKERS and --maxWorkers still override this value.
    maxWorkers: envSet('GITHUB_ACTIONS') ? undefined : 6,
    projects: [
      {
        extends: true,
        test: {
          environment: 'node',
          include: ['test/**/*.test.ts'],
          name: 'unit',
          testTimeout: 30_000,
        },
      },
    ],
    reporters: reporters(),
  },
});
