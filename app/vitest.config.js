export default {
  css: {
    postcss: { plugins: [] },
  },
  test: {
    include: [
      'engine/test/**/*.test.js',
      'api/test/**/*.test.js',
      'web/src/**/*.test.js',
    ],
  },
};
