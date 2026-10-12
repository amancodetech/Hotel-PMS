export default {
  modulePathIgnorePatterns: ['<rootDir>/.local/'],
  testMatch: ['<rootDir>/tests/distribution/integration/**/*.test.mjs'],
  testEnvironment: 'node',
  testTimeout: 30000,
  maxWorkers: 1,
  verbose: true,
};
