import serverless from '@stormkit/serverless';
import app from './server.js';
export const handler = serverless(app);
