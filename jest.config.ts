import type { Config } from 'jest';

const config: Config = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/tests'],
  testMatch: ['**/*.test.ts'],
  transform: {
    '^.+\\.tsx?$': ['ts-jest', { tsconfig: 'tsconfig.test.json' }],
  },
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/src/$1',
  },
  // Set required env vars before any test module is imported.
  setupFiles: ['<rootDir>/tests/setup.ts'],
  testTimeout: 30000,
  // Explicitly ignore zod's own tests inside node_modules.
  testPathIgnorePatterns: ['/node_modules/'],
  collectCoverage: false,
};

export default config;
