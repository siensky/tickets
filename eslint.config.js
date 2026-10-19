// Root ESLint config for the whole monorepo.
//
// Enforces docs/rules.md: layer boundaries (controllers -> services ->
// repositories), no default exports, no `any`, no console.log, and file/
// function length limits. Everything here is `error`, not `warn` — a rule
// that only warns gets ignored once enough code is generated (rules.md §0).
import eslintJs from '@eslint/js';
import boundaries from 'eslint-plugin-boundaries';
import prettierConfig from 'eslint-config-prettier';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/build/**',
      '**/.turbo/**',
      '**/node_modules/**',
      '**/coverage/**',
      '**/.expo/**',
      '**/*.config.js',
      '**/*.config.cjs',
      '**/*.config.mjs',
      '**/*.config.ts',
      'infra/**',
    ],
  },
  eslintJs.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  prettierConfig,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: { boundaries },
    settings: {
      'boundaries/elements': [
        { type: 'routes', pattern: 'services/*/src/routes/**' },
        { type: 'controllers', pattern: 'services/*/src/controllers/**' },
        { type: 'services-layer', pattern: 'services/*/src/services/**' },
        { type: 'repositories', pattern: 'services/*/src/repositories/**' },
        { type: 'mappers', pattern: 'services/*/src/mappers/**' },
        { type: 'schemas-layer', pattern: 'services/*/src/schemas/**' },
        { type: 'service-root', pattern: 'services/*/src/index.ts', partialMatch: false },
        { type: 'shared', pattern: 'shared/*/src/**' },
      ],
    },
    rules: {
      // --- rules.md §2: TypeScript ---
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-non-null-assertion': 'error',
      '@typescript-eslint/explicit-module-boundary-types': 'error',
      '@typescript-eslint/ban-ts-comment': [
        'error',
        { 'ts-ignore': true, 'ts-expect-error': 'allow-with-description' },
      ],
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],

      // Named exports only (rules.md §2) — no default exports.
      'no-restricted-syntax': [
        'error',
        {
          selector: 'ExportDefaultDeclaration',
          message: 'Default exports are not allowed — use named exports (docs/rules.md §2).',
        },
      ],

      // rules.md §7: no console.log in production code.
      'no-console': 'error',

      // rules.md §1: max 300 lines/file, 50 lines/function.
      'max-lines': ['error', { max: 300, skipBlankLines: true, skipComments: true }],
      'max-lines-per-function': [
        'error',
        { max: 50, skipBlankLines: true, skipComments: true, IIFEs: true },
      ],

      // rules.md §1: layer boundaries.
      'boundaries/element-types': [
        'error',
        {
          default: 'disallow',
          rules: [
            { from: 'routes', allow: ['controllers', 'schemas-layer', 'shared'] },
            {
              from: 'controllers',
              allow: ['services-layer', 'schemas-layer', 'mappers', 'shared'],
            },
            {
              from: 'services-layer',
              allow: ['repositories', 'mappers', 'schemas-layer', 'shared'],
            },
            { from: 'repositories', allow: ['mappers', 'shared'] },
            { from: 'mappers', allow: ['shared'] },
            { from: 'schemas-layer', allow: ['shared'] },
            {
              from: 'service-root',
              allow: [
                'routes',
                'controllers',
                'services-layer',
                'repositories',
                'mappers',
                'schemas-layer',
                'shared',
              ],
            },
          ],
        },
      ],
    },
  },
  {
    // rules.md §1: services/ and repositories/ stay framework-agnostic.
    files: ['services/*/src/services/**', 'services/*/src/repositories/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'fastify',
              message:
                'services/ and repositories/ must stay framework-agnostic — no Fastify here (docs/rules.md §1).',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['**/*.test.ts', '**/*.spec.ts', '**/tests/**/*.ts'],
    rules: {
      'max-lines-per-function': 'off',
      'max-lines': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
  {
    // Frontend apps don't follow the service layer structure.
    files: ['apps/**/*.{ts,tsx}'],
    rules: {
      'boundaries/element-types': 'off',
    },
  },
);
