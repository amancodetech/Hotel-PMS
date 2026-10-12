export default {
  testMatch: ['<rootDir>/tests/property/**/*.test.mjs'],
  testEnvironment: 'node',
  setupFiles: ['<rootDir>/tests/setup.mjs'],
  modulePathIgnorePatterns: ['<rootDir>/.local/'],
  testTimeout: 60000,
  maxWorkers: 1,
};
