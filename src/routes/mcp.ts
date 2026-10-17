import Express, { Router } from 'express';
import debug from 'debug';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import config from '@/config';
import { createMcpServer } from '@/mcp';

const DEBUG = debug('services:routes:mcp');

const router = Router();

// Exposes private notes and the library, so it's behind the app secret.
const path = `/mcp/${config.app.secret}`;

// Stateless: each request gets its own server and transport, so there are no sessions to track.
router.post(path, Express.json({ limit: '10mb' }), async (req, res) => {
  const server = createMcpServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on('close', () => {
    transport.close();
    server.close();
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (ex) {
    DEBUG(ex);
    if (!res.headersSent) {
      res.status(500).send({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null });
    }
  }
});

// No sessions means no server-initiated stream to GET, and nothing to DELETE.
router.all(path, (_, res) => {
  res.status(405).set('Allow', 'POST').send({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null });
});

export default router;
