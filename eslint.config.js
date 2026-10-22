const js = require("@eslint/js");
const globals = require("globals");
const { defineConfig, globalIgnores } = require("eslint/config");

module.exports = defineConfig([
  globalIgnores(["node_modules/**", "data/**", "coverage/**", "**/.env*"]),
  {
    files: ["**/*.js"],
    extends: [js.configs.recommended],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "commonjs",
      globals: globals.node,
    },
    rules: {
      "no-var": "error",
      "prefer-const": ["error", { ignoreReadBeforeAssign: true }],
      "no-unused-vars": ["error", { ignoreRestSiblings: true }],
      eqeqeq: ["error", "always", { null: "ignore" }],
    },
  },
]);
