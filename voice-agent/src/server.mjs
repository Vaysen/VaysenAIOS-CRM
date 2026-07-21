import { createServer } from 'node:http';

const port = Number(process.env.PORT || 4100);
const providerMode = process.env.VOICE_PROVIDER_MODE || 'disabled';
const allowedModes = new Set(['disabled', 'livekit-dev', 'livekit']);
if (!allowedModes.has(providerMode)) throw new Error(`Unsupported VOICE_PROVIDER_MODE: ${providerMode}`);

const server = createServer((request, response) => {
  response.setHeader('content-type', 'application/json; charset=utf-8');
  if (request.url === '/health') {
    response.end(JSON.stringify({ ok: true, service: 'vaysen-ai-crm-voice-agent', providerMode }));
    return;
  }
  if (request.url === '/ready') {
    const ready = providerMode !== 'disabled' && Boolean(process.env.LIVEKIT_URL && process.env.LIVEKIT_API_KEY && process.env.LIVEKIT_API_SECRET);
    response.statusCode = ready ? 200 : 503;
    response.end(JSON.stringify({ ready, providerMode, reason: ready ? undefined : 'LiveKit credentials are not provisioned' }));
    return;
  }
  response.statusCode = 404;
  response.end(JSON.stringify({ error: 'not_found' }));
});

server.listen(port, '0.0.0.0', () => console.log(`voice-agent control plane listening on ${port}`));

const shutdown = () => server.close(() => process.exit(0));
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
