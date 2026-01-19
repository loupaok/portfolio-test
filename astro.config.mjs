import { defineConfig } from 'astro/config';
import mdx from '@astrojs/mdx';
import tailwindcss from '@tailwindcss/vite';

// https://astro.build/config
export default defineConfig({
  integrations: [mdx()],
  image: {
    // Allow images from WordPress (fallback if not downloaded locally)
    remotePatterns: [
      {
        protocol: 'https',
        hostname: 'webwork.lkouros.com',
      },
      {
        protocol: 'http',
        hostname: 'webwork.lkouros.com',
      },
    ],
  },
  vite: {
    plugins: [tailwindcss()],
    server: {
      headers: {
        // Allow iframe embedding in development only (for IDE preview)
        // Note: vite.server.headers only applies to dev server, not production builds
        'Content-Security-Policy': "frame-ancestors *",
      },
      // HMR configuration for GitHub Codespaces
      hmr: {
        clientPort: 443,
        protocol: 'wss',
      },
      watch: {
        // Use native file watchers (faster than polling)
        // If you experience issues in containers, set usePolling: true
        ignored: ['**/node_modules/**', '**/.git/**', '**/dist/**', '**/.output/**'],
      },
    },
  },
});
