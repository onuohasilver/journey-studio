// ---- The API, mounted into Vite in dev and standalone in production ----

import express, {type Express} from 'express';
import {createAiRouter} from './ai';
import {createApiRouter} from './proxy';
import {createJourneyRouter} from './journeys';
import {createInboxRouter} from './inbox';

export function createApi(root = process.cwd()): Express {
  const app = express();
  app.use('/api/ai', createAiRouter());
  // Before the JSON-parsing routers: a delivery may arrive as anything, and the
  // inbox reads the raw body itself.
  app.use('/api', createInboxRouter(root));
  app.use('/api', createJourneyRouter(root));
  app.use('/api', createApiRouter(root));
  return app;
}

/** `node server/index.ts` runs the API on its own, for a built front end. */
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop() ?? '')) {
  const port = Number(process.env.PORT ?? 5178);
  createApi().listen(port, () => {
    // eslint-disable-next-line no-console
    console.log(`journey-studio api on http://localhost:${port}`);
  });
}
