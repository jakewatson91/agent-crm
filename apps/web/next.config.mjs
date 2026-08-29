/** @type {import('next').NextConfig} */
const nextConfig = {
  // `pnpm verify` runs a production `next build` into the same `.next` dir
  // `next dev --turbopack` writes to, and building while dev is up corrupts
  // dev's cache — every page starts 500ing with ENOENT on `_buildManifest.js.tmp.*`,
  // and dev doesn't crash or log anything pointing at the cause. Hit live
  // 2026-08-25 and again 2026-08-29 (two concurrent Claude Code sessions in
  // this repo, one running verify while the other's dev server was up).
  // VERIFY_BUILD=1 (set by the root `verify` script) routes the build to its
  // own directory instead, so the two can never collide again.
  distDir: process.env.VERIFY_BUILD === '1' ? '.next-verify' : '.next',
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
