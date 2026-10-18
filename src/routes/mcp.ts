import Express, { Router } from 'express';
import debug from 'debug';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { authorizationHandler } from '@modelcontextprotocol/sdk/server/auth/handlers/authorize.js';
import { tokenHandler } from '@modelcontextprotocol/sdk/server/auth/handlers/token.js';
import { metadataHandler } from '@modelcontextprotocol/sdk/server/auth/handlers/metadata.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import { createMcpServer } from '@/mcp';
import {
  approveHandler,
  authorizationServerMetadata,
  issuer,
  protectedResourceMetadata,
  provider,
  resource,
} from '@/mcp/auth';

const DEBUG = debug('services:routes:mcp');

const router = Router();

const path = '/mcp';
const resourceMetadataPath = '/.well-known/oauth-protected-resource/mcp';

// OAuth discovery, authorization, and tokens. See src/mcp/auth.ts.
router.use('/.well-known/oauth-authorization-server', metadataHandler(authorizationServerMetadata));
router.use(resourceMetadataPath, metadataHandler(protectedResourceMetadata));
router.use('/.well-known/oauth-protected-resource', metadataHandler(protectedResourceMetadata));
router.use('/authorize', authorizationHandler({ provider }));
router.use('/token', tokenHandler({ provider }));
router.post('/oauth/approve', Express.urlencoded({ extended: false }), approveHandler);

// Exposes private notes, the library, and tasks, so it requires an OAuth access token.
router.use(path, requireBearerAuth({
  verifier: provider,
  resourceMetadataUrl: new URL(resourceMetadataPath, issuer).href,
  expectedResource: new URL(resource),
}));

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
