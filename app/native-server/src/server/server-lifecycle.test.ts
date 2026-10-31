import { afterEach, describe, expect, jest, test } from '@jest/globals';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type ServerInstance from './index';
import type NativeHostInstance from '../native-messaging-host';

const ALLOWED_ORIGIN = 'http://127.0.0.1:1420';

type Server = typeof ServerInstance;

/** Fastify cannot listen again after close(), so every test gets a fresh singleton. */
function loadServer(): { server: Server; nativeHost: typeof NativeHostInstance } {
  let loaded!: { server: Server; nativeHost: typeof NativeHostInstance };
  jest.isolateModules(() => {
    loaded = {
      server: require('./index').default,
      nativeHost: require('../native-messaging-host').default,
    };
  });
  return loaded;
}

async function startServer(): Promise<{ server: Server; port: number }> {
  const { server, nativeHost } = loadServer();
  await server.start(0, nativeHost);
  started.push(server);
  return { server, port: (server.getInstance().server.address() as AddressInfo).port };
}

/** Open the standing GET stream a Streamable HTTP MCP client keeps per session. */
async function openMcpStream(port: number): Promise<http.ClientRequest> {
  const init = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers: {
      Origin: ALLOWED_ORIGIN,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'lifecycle-test', version: '0' },
      },
    }),
  });
  await init.text();
  const sessionId = init.headers.get('mcp-session-id');
  if (!sessionId) throw new Error(`initialize returned ${init.status} without a session`);

  const { promise, resolve, reject } = Promise.withResolvers<http.ClientRequest>();
  const request = http.get(
    {
      host: '127.0.0.1',
      port,
      path: '/mcp',
      headers: { Origin: ALLOWED_ORIGIN, Accept: 'text/event-stream', 'Mcp-Session-Id': sessionId },
    },
    (response) => {
      response.on('error', () => undefined);
      if (response.statusCode === 200) resolve(request);
      else reject(new Error(`MCP stream returned ${response.statusCode}`));
    },
  );
  request.on('error', () => undefined);
  return promise;
}

// Real deadline on purpose: the failure being guarded is a close() that never settles.
function within<T>(promise: Promise<T>, ms: number): Promise<T | 'timeout'> {
  const deadline = Promise.withResolvers<'timeout'>();
  setTimeout(() => deadline.resolve('timeout'), ms).unref();
  return Promise.race([promise, deadline.promise]);
}

function postTakeover(port: number): Promise<number> {
  const { promise, resolve, reject } = Promise.withResolvers<number>();
  const request = http.request(
    { host: '127.0.0.1', port, path: '/__chrome_mcp_bridge/takeover', method: 'POST' },
    (response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
    },
  );
  request.on('error', reject);
  request.end();
  return promise;
}

const started: Server[] = [];
const previousStandalone = process.env.CHROME_MCP_STANDALONE;

describe('Server lifecycle', () => {
  afterEach(async () => {
    if (previousStandalone === undefined) delete process.env.CHROME_MCP_STANDALONE;
    else process.env.CHROME_MCP_STANDALONE = previousStandalone;
    for (const server of started.splice(0)) await within(server.stop(), 2_000);
    jest.restoreAllMocks();
  });

  test('stop() releases the port while an MCP client holds a stream open', async () => {
    const { server, port } = await startServer();
    const stream = await openMcpStream(port);

    // A hung close() leaves a host that holds the extension but no listener.
    const outcome = await within(server.stop(), 3_000);
    stream.destroy();

    expect(outcome).not.toBe('timeout');
    expect(server.isRunning).toBe(false);
  }, 10_000);

  test('a Chrome-launched native host refuses to hand over its port', async () => {
    delete process.env.CHROME_MCP_STANDALONE;
    // Guards the test runner if the refusal regresses into a scheduled exit.
    jest.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const { server, port } = await startServer();

    expect(await postTakeover(port)).toBe(404);
    expect(server.isRunning).toBe(true);
  });

  test('a standalone service yields its port to the native host', async () => {
    process.env.CHROME_MCP_STANDALONE = '1';
    const exited = Promise.withResolvers<unknown>();
    jest.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      exited.resolve(code);
    }) as never);
    const { server, port } = await startServer();

    expect(await postTakeover(port)).toBe(200);
    expect(await within(exited.promise, 3_000)).toBe(0);
    expect(server.isRunning).toBe(false);
  });
});
