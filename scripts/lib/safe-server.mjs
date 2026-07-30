import { createServer } from 'node:http';
import { createReadStream, existsSync, realpathSync, statSync } from 'node:fs';
import { extname, resolve, sep } from 'node:path';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
};

function within(root, file) {
  return file === root || file.startsWith(root + sep);
}

function toSafeFile(rootReal, rawUrl) {
  try {
    const rawPath = String(rawUrl ?? '/').split('?')[0].split('#')[0];
    const decodedRawPath = decodeURIComponent(rawPath);
    if (decodedRawPath === '/..' || decodedRawPath.startsWith('/../') || decodedRawPath.includes('/../'))
      return { status: 403 };
  } catch {
    return { status: 400 };
  }
  let pathname;
  try {
    pathname = new URL(rawUrl ?? '/', 'http://qa-hifi.local').pathname;
  } catch {
    return { status: 400 };
  }
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return { status: 400 };
  }
  const target = resolve(rootReal, `.${decoded === '/' ? '/index.html' : decoded}`);
  if (!within(rootReal, target)) return { status: 403 };
  if (!existsSync(target)) return { status: 404 };
  let real;
  try {
    real = realpathSync(target);
  } catch {
    return { status: 404 };
  }
  if (!within(rootReal, real)) return { status: 403 };
  if (!statSync(real).isFile()) return { status: 404 };
  return { status: 200, file: real };
}

export function createSafeStaticServer(rootDir) {
  const rootReal = realpathSync(resolve(rootDir));
  const server = createServer((req, res) => {
    if (!['GET', 'HEAD'].includes(req.method ?? 'GET')) {
      res.writeHead(405).end();
      return;
    }
    const safe = toSafeFile(rootReal, req.url);
    if (safe.status !== 200) {
      res.writeHead(safe.status).end(safe.status === 403 ? 'Forbidden' : 'Not found');
      return;
    }
    const type = TYPES[extname(safe.file).toLowerCase()] ?? 'application/octet-stream';
    res.writeHead(200, {
      'content-type': type,
      'x-content-type-options': 'nosniff',
      'cache-control': 'no-store',
    });
    if (req.method === 'HEAD') res.end();
    else createReadStream(safe.file).pipe(res);
  });
  return {
    server,
    rootReal,
    async listen(host = '127.0.0.1') {
      await new Promise((resolveListen) => server.listen(0, host, resolveListen));
      return `http://${host}:${server.address().port}/`;
    },
    async close() {
      await new Promise((resolveClose) => server.close(resolveClose));
    },
  };
}
