/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    typedRoutes: false,
  },
  transpilePackages: ['@agent-crm/primitives', '@agent-crm/tools', '@agent-crm/agents', '@agent-crm/db', '@agent-crm/inngest'],
  // Resolve `.js` import specifiers in workspace TS sources to their `.ts` counterparts.
  // Source files use `./foo.js` (required by tsconfig moduleResolution=Bundler + verbatimModuleSyntax),
  // but at build time webpack needs to land on the actual .ts file.
  webpack: (config) => {
    config.resolve.extensionAlias = {
      '.js': ['.ts', '.tsx', '.js'],
    };
    return config;
  },
};

export default nextConfig;
