import Express from 'express';
import config from '@/config';
import debug from 'debug';
import routes from './routes';

const DEBUG = debug('services:server');

const express = Express();

export async function startServer() {
  // Register all routes
  express.use(routes);
  
  express
    .listen(
      config.app.port,
      () => DEBUG(`Listening on http://0.0.0.0:${config.app.port}`)
    );
}