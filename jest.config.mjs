const project = (displayName, testMatch) => ({
  displayName,
  testEnvironment: 'node',
  testMatch,
});

export default {
  projects: [
    project('unit', ['<rootDir>/test/unit/**/*.test.mjs']),
    project('e2e', ['<rootDir>/test/e2e/**/*.test.mjs']),
    project('integration', ['<rootDir>/test/integration/**/*.test.mjs']),
  ],
};
