const project = (displayName, testMatch) => ({
  displayName,
  testEnvironment: 'node',
  testMatch,
});

export default {
  projects: [
    project('foundation-unit', ['<rootDir>/test/unit/foundation/**/*.test.mjs']),
    project('foundation-e2e', ['<rootDir>/test/e2e/foundation/**/*.test.mjs']),
    project('integration', ['<rootDir>/test/integration/**/*.test.mjs']),
  ],
};
