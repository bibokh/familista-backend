import type { Config } from 'jest';

const config: Config = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/tests'],
  testMatch: ['**/*.test.ts'],
  // ts-jest transpiles each file on its own: tsconfig.test.json sets
  // `isolatedModules`, so Jest runs code and never type-checks it.
  //
  // Type-checking is not dropped. It is one pass of its own, `npm run typecheck`
  // (tsc --noEmit -p tsconfig.test.json), over src, tests and lab: a CI step of
  // its own, and the same flag makes tsc refuse anything per-file transpilation
  // could get wrong.
  //
  // Why: checking inside Jest built the whole program, Prisma's 21.7 MB of
  // generated client types included, once for every file Jest loaded. With a
  // cold cache, which is what every CI runner has, a test that imports the app
  // peaked at about 2.9 GB of heap against Node's 2 GB default, and CI failed
  // at random. Transpiling, that same test peaks at about 0.44 GB.
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
