import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { createApp } from './app.js';
import { createStore } from './store.js';
import { QwenJobs, imageProcessingConfiguration } from './qwen.js';
import { ProposalStore } from './proposals.js';
import { ProjectPermissions } from './permissions.js';

export function startServer() {
  const staticDir = path.resolve(process.cwd(), 'dist');
  const store = createStore();
  const processing = imageProcessingConfiguration();
  const proposals = new ProposalStore(store, { processing: backend => processing[backend] });
  const permissions = new ProjectPermissions(store);
  const jobs = new QwenJobs(store, { proposals, permissions, processing });
  const app = createApp({ staticDir, store, proposals, permissions, jobs });
  const server = app.listen(7317, '127.0.0.1', () => {
    console.log('MaskCanvas local server listening at http://127.0.0.1:7317');
  });
  server.on('close', () => jobs.close());
  return server;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) startServer();

