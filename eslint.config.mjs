import js from '@eslint/js';

// 浏览器扩展跑在三种环境里：Service Worker（background.js）、扩展页面
// （sidepanel/**）、内容脚本（content-*.js，普通脚本、没有模块作用域）。
const browserGlobals = {
  chrome: 'readonly',
  console: 'readonly',
  crypto: 'readonly',
  performance: 'readonly',
  structuredClone: 'readonly',
  fetch: 'readonly',
  window: 'readonly',
  document: 'readonly',
  navigator: 'readonly',
  setTimeout: 'readonly',
  clearTimeout: 'readonly',
  setInterval: 'readonly',
  clearInterval: 'readonly',
  requestAnimationFrame: 'readonly',
  cancelAnimationFrame: 'readonly',
  ResizeObserver: 'readonly',
  Blob: 'readonly',
  URL: 'readonly',
  CSS: 'readonly',
};

export default [
  { ignores: ['node_modules/**'] },
  js.configs.recommended,
  {
    files: ['**/*.js', '**/*.mjs'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: browserGlobals,
    },
    rules: {
      'no-unused-vars': ['error', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrors: 'none',
      }],
      eqeqeq: ['error', 'smart'],
      'no-var': 'error',
      'prefer-const': 'error',
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-throw-literal': 'error',
      'no-self-assign': 'error',
      'no-unmodified-loop-condition': 'error',
    },
  },
  {
    // 内容脚本是经典脚本，没有模块作用域：多声明一个变量就是往页面里泄漏。
    files: ['content-*.js'],
    languageOptions: {
      sourceType: 'script',
    },
    rules: {
      'no-implicit-globals': 'error',
    },
  },
  {
    files: ['tests/**/*.mjs'],
    languageOptions: {
      globals: {
        ...browserGlobals,
        process: 'readonly',
        setImmediate: 'readonly',
        Buffer: 'readonly',
      },
    },
  },
];
