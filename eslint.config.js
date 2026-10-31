import js from "@eslint/js";
import globals from "globals";

export default [
  {
    ignores: ["node_modules/**", "src/vendor/**", "dist/**", ".wrangler/**", ".vinext/**", ".sites-runtime/**"],
  },
  js.configs.recommended,
  {
    files: ["src/**/*.js", "test/**/*.js", "scripts/**/*.mjs"],
    languageOptions: {
      sourceType: "module",
      ecmaVersion: 2024,
      globals: { ...globals.browser, ...globals.node },
    },
    rules: {
      "no-console": "warn",
      "no-restricted-globals": ["error", "event"],
      "no-eval": "error",
      "no-implicit-coercion": "error",
      "no-plusplus": "off",
      "no-underscore-dangle": "off",
      "prefer-const": "off",
      "no-var": "error",
      "object-shorthand": "error",
      "arrow-body-style": ["error", "as-needed"],
      "no-unused-vars": "off",
      "semi": ["error", "always"],
      "quotes": ["warn", "single", { avoidEscape: true }],
      "comma-dangle": ["error", "always-multiline"],
      "indent": ["error", 2, { SwitchCase: 1 }],
      "eol-last": "error",
      "curly": "off",
      "eqeqeq": "off",
    },
  },
];
