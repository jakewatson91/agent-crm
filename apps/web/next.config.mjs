/** @type {import('next').NextConfig} */
const nextConfig = {
  typedRoutes: false,
  // The production build does not run tsc type-checking or eslint. Workspace
  // packages import siblings with explicit `./foo.ts` specifiers, which tsc
  // rejects (TS5097) without allowImportingTsExtensions; types are checked
  // separately via each package's `tsc --noEmit`. The bundler resolves the real
  // .ts/.tsx files fine (see webpack.resolve.extensionAlias below).
  typescript: { ignoreBuildErrors: true },
  eslint: { ignoreDuringBuilds: true },
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
  // Production build runs webpack (build script dropped --turbopack). Workspace .ts
  // sources import siblings with explicit `./foo.js` specifiers; webpack must remap
  // the explicit extension to the real .ts/.tsx file. turbopack.resolveExtensions
  // above only covers EXTENSIONLESS imports, not explicit `.js` -> `.ts`, which is
  // why the turbopack build failed across the inngest module graph.
  webpack: (config) => {
    config.resolve.extensionAlias = {
      ...(config.resolve.extensionAlias ?? {}),
      '.js': ['.ts', '.tsx', '.js'],
      '.jsx': ['.tsx', '.jsx'],
      '.mjs': ['.mts', '.mjs'],
    };
    return config;
  },
};

export default nextConfig;
