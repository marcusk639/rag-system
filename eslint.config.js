// @ts-check
import tseslint from "typescript-eslint";

export default [
  // Global ignores — applied before any rule set.
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "**/*.generated.ts",
      "apps/web/**", // Next.js app manages its own lint via `next lint`
      "services/**", // Python parser sidecar — not TypeScript
      ".worktrees/**",
      ".scratch*/",
      ".remember/**", // session memory scratch files
      "examples/**",
    ],
  },

  // TypeScript-aware recommended rules for all .ts files.
  ...tseslint.configs.recommended,

  // Project-specific overrides (applied after recommended).
  {
    rules: {
      // Allow unused vars/args/params when prefixed with _
      // (common in callbacks, catch clauses, interface implementations).
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          args: "all",
          argsIgnorePattern: "^_",
          caughtErrors: "all",
          caughtErrorsIgnorePattern: "^_",
          destructuredArrayIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          ignoreRestSiblings: true,
        },
      ],
      // Pino is the logger; console.log/warn/error in app code is a slip.
      // Warn so intentional `// eslint-disable-next-line no-console` annotations remain valid.
      "no-console": "warn",
    },
  },

  // Utility scripts — console output is intentional; must come after the
  // project-wide `no-console: warn` so this per-files override wins.
  {
    files: ["scripts/**"],
    rules: { "no-console": "off" },
  },
];
