export default {
  modulePathIgnorePatterns: ['<rootDir>/.local/'],
  testMatch: ['<rootDir>/tests/identity/**/*.test.mjs'],
  testEnvironment: 'node',
  setupFiles: ['<rootDir>/tests/setup.mjs'],
  testTimeout: 60000,
};
