export default {
  testMatch: ['<rootDir>/tests/**/*.test.mjs', '<rootDir>/tests/**/*.test.tsx'],
  modulePathIgnorePatterns: ['<rootDir>/.local/'],
  testPathIgnorePatterns: [
    '/node_modules/',
    '<rootDir>/tests/distribution/integration/',
    '<rootDir>/tests/identity/',
    '<rootDir>/tests/property/',
  ],
  testEnvironment: 'node',
  setupFiles: ['<rootDir>/tests/setup.mjs'],
  extensionsToTreatAsEsm: ['.ts', '.tsx'],
  transform: { '^.+\\.tsx?$': '<rootDir>/tests/transform.mjs' },
  moduleNameMapper: { '^(\\.{1,2}/.*)\\.js$': '$1' },
  testTimeout: 10000,
};
