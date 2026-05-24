/** @type {import('next').NextConfig} */
const nextConfig = {
  typedRoutes: false,
  experimental: {
    // `optimizePackageImports` was previously set to tree-shake the @agent-crm/*
    // barrels — but Turbopack's rewrite breaks the `.js` → `.ts` extension-alias
    // mapping (turbopack.resolveExtensions below) for any workspace package that
    // ships .ts source with `./foo.js` import specifiers. Result: random routes
    // 500 with "Module not found: Can't resolve './action_selector.js'". Disabling
    // the optimization for workspace packages is the only reliable fix; the
    // dev-compile time hit is minor compared to the broken-routes blast radius.
    // Re-enable per-package only if you've verified Turbopack handles its imports.
    optimizePackageImports: [],
  },
  transpilePackages: ['@agent-crm/primitives', '@agent-crm/tools', '@agent-crm/agents', '@agent-crm/db', '@agent-crm/inngest', '@agent-crm/composio'],
  // Workspace TS sources use `./foo.js` specifiers (required by tsconfig moduleResolution=Bundler
  // + verbatimModuleSyntax) but the actual files are `.ts`. Turbopack resolves these via
  // resolveExtensions. Dev and build both run turbopack (--turbopack flag in both scripts).
  turbopack: {
    resolveExtensions: ['.tsx', '.ts', '.jsx', '.js', '.mjs', '.json'],
  },
};

export default nextConfig;
