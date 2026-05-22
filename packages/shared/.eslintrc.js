module.exports = {
  root: true,
  extends: ['@concurrency/eslint-config'],
  parserOptions: {
    project: 'tsconfig.json',
    tsconfigRootDir: __dirname,
  },
  ignorePatterns: ['.eslintrc.js', 'dist'],
};
