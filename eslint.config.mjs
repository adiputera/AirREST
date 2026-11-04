import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/dist-offline/**',
      '**/node_modules/**',
      '**/public/icons/**',
      '**/public/icons-offline/**',
      '**/.next/**',
      '**/out/**',
      '**/src-tauri/**',
      'scripts/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['apps/extension/public/**/*.js'],
    languageOptions: {
      globals: {
        chrome: 'readonly',
        self: 'readonly',
        window: 'readonly',
        console: 'readonly',
        Date: 'readonly',
        Map: 'readonly',
        Boolean: 'readonly',
      },
    },
  },
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-explicit-any': 'warn',
    },
  }
);
