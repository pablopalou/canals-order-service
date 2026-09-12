import js from '@eslint/js';
import tseslint from 'typescript-eslint';

/**
 * The compiler already runs strict, with noUncheckedIndexedAccess and
 * erasableSyntaxOnly, so this config does not repeat what tsc catches. What it
 * adds are the type-aware rules a type checker cannot express — above all a
 * forgotten `await`, which in a service that holds database locks is silent
 * corruption rather than a style problem.
 */
export default tseslint.config(
  { ignores: ['dist/', 'drizzle/', 'node_modules/'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      parserOptions: {
        projectService: {
          // This config file is not part of the compiled project.
          allowDefaultProject: ['eslint.config.js'],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-floating-promises': [
        'error',
        {
          // node:test's own functions return promises that are not meant to
          // be awaited. Narrowing the rule keeps it meaningful everywhere
          // else, which switching it off for tests would not.
          allowForKnownSafeCalls: [
            {
              from: 'package',
              package: 'node:test',
              name: [
                'after',
                'afterEach',
                'before',
                'beforeEach',
                'describe',
                'it',
                'test',
              ],
            },
          ],
        },
      ],
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/await-thenable': 'error',
      '@typescript-eslint/return-await': ['error', 'always'],
      '@typescript-eslint/no-unnecessary-condition': 'error',
      eqeqeq: ['error', 'always'],
      'prefer-const': 'error',
      'no-var': 'error',
    },
  },
);
