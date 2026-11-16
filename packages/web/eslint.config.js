// ESLint — correctness, not style. Formatting belongs to Prettier
// (.prettierrc.json, checked by `npm run format:check`); eslint-config-prettier
// goes last so no stylistic rule can fight it. Repo-specific rules (tokens only, no styling component internals, docs
// pairing…) live in scripts/guard.mjs.
import js from '@eslint/js'
import pluginVue from 'eslint-plugin-vue'
import tseslint from 'typescript-eslint'
import vueParser from 'vue-eslint-parser'
import globals from 'globals'
import prettier from 'eslint-config-prettier'

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', '.shots/**', '.scratch/**'] },

  js.configs.recommended,
  ...tseslint.configs.recommended,
  ...pluginVue.configs['flat/essential'],

  {
    files: ['**/*.{ts,vue}'],
    languageOptions: {
      parser: vueParser,
      parserOptions: {
        parser: tseslint.parser,
        ecmaVersion: 'latest',
        sourceType: 'module',
        extraFileExtensions: ['.vue'],
      },
      globals: { ...globals.browser },
    },
    rules: {
      // TypeScript already checks identifiers; this rule misfires on DOM lib types (ParentNode…)
      'no-undef': 'off',
      // single-word names are the library convention (Button.vue → IuButton)
      'vue/multi-word-component-names': 'off',
      'vue/no-v-html': 'error',
      'vue/no-mutating-props': 'error',
      'vue/require-v-for-key': 'error',
      'vue/no-unused-vars': 'error',
      'vue/no-unused-components': 'error',
      'vue/no-useless-template-attributes': 'error',
      'vue/no-ref-as-operand': 'error',
      'vue/no-setup-props-reactivity-loss': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-explicit-any': 'error',
      'no-console': ['error', { allow: ['warn', 'error'] }],
      'prefer-const': 'error',
      eqeqeq: ['error', 'always', { null: 'ignore' }],
    },
  },

  // Icon injects the static SVG strings from icons.ts — the one sanctioned v-html
  { files: ['src/components/Icon/Icon.vue'], rules: { 'vue/no-v-html': 'off' } },

  // node scripts
  {
    files: ['scripts/**/*.mjs', '*.config.{js,ts}'],
    languageOptions: { globals: { ...globals.node } },
    rules: { 'no-console': 'off' },
  },

  prettier,
)
