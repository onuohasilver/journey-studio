import {defineConfig, loadEnv, type PluginOption} from 'vite';
import react from '@vitejs/plugin-react';
import {createApi} from './server/index';

/**
 * Secrets the API reads from process.env.
 *
 * Vite's own env handling does not cover this: `loadEnv` feeds
 * `import.meta.env`, and only `VITE_*` names reach the client bundle — these
 * deliberately are not `VITE_*`, so they must stay in the node process.
 * Bridging them lets a key live in a gitignored `.env.local` instead of having
 * to be exported in whatever shell happens to start the dev server.
 */
const SERVER_ONLY = ['ANTHROPIC_API_KEY', 'SLACK_WEBHOOK_URL'];

/**
 * The API runs inside the dev server rather than as a second process.
 *
 * One command starts everything, and — more importantly — the proxy that holds
 * your credentials is the same origin as the app, so there is no CORS dance and
 * no second port to remember.
 */
function apiPlugin(): PluginOption {
  return {
    name: 'journey-studio-api',
    configureServer(server) {
      const api = createApi(server.config.root);
      server.middlewares.use(api);
    },
    configurePreviewServer(server) {
      server.middlewares.use(createApi());
    },
  };
}

export default defineConfig(({mode}) => {
  const fileEnv = loadEnv(mode, process.cwd(), '');
  for (const name of SERVER_ONLY) {
    // A real shell export still wins, so CI and one-off overrides behave.
    if (!process.env[name] && fileEnv[name]) process.env[name] = fileEnv[name];
  }

  return {
    plugins: [react(), apiPlugin()],
    server: {
      port: Number(process.env.PORT) || 5180,
      // Vite rejects requests whose Host it does not recognise, which is the
      // right default — it is what stops a public tunnel from reaching a dev
      // server by accident. Set TUNNEL=1 to allow ngrok hosts specifically,
      // rather than reaching for `true` and allowing every host there is.
      ...(process.env.TUNNEL
        ? {allowedHosts: ['.ngrok-free.app', '.ngrok-free.dev', '.ngrok.app', '.ngrok.io']}
        : {}),
    },
  };
});
