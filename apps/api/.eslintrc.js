module.exports = {
  root: true,
  extends: ['@concurrency/eslint-config'],
  parserOptions: {
    project: 'tsconfig.json',
    tsconfigRootDir: __dirname,
    sourceType: 'module',
  },
  ignorePatterns: ['.eslintrc.js', 'dist'],
};
