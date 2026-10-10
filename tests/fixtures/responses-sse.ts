import { createServer, type RequestListener, type ServerResponse } from 'node:http';

export async function startGatewayFixture(handler: RequestListener): Promise<{
  origin: string; baseURL: string; close(): Promise<void>;
}> {
  const server = createServer(handler);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fixture did not bind');
  const origin = `http://127.0.0.1:${address.port}`;
  return { origin, baseURL: origin + '/v1', async close() {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  } };
}
export function writeSse(response: ServerResponse, events: readonly { event: string; data: unknown }[], end = true): void {
  if (!response.headersSent) response.setHeader('Content-Type', 'text/event-stream');
  for (const event of events) response.write(`event: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`);
  if (end) response.end();
}
