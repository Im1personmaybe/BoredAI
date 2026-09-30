const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const PORT = Number(process.env.PORT || 10000);
const HOST = '0.0.0.0';
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const PUBLIC_DIR = __dirname;
const MAX_BODY = 120_000;
const WINDOW_MS = 60_000;
const MAX_REQUESTS_PER_WINDOW = 20;
const rateBuckets = new Map();

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function clientIp(req) {
  return (req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown').toString().split(',')[0].trim();
}

function allowed(ip) {
  const now = Date.now();
  const recent = (rateBuckets.get(ip) || []).filter(time => now - time < WINDOW_MS);
  if (recent.length >= MAX_REQUESTS_PER_WINDOW) {
    rateBuckets.set(ip, recent);
    return false;
  }
  recent.push(now);
  rateBuckets.set(ip, recent);
  return true;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let data = '';
    req.setEncoding('utf8');
    req.on('data', chunk => {
      size += Buffer.byteLength(chunk);
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('Request body is too large'), { statusCode: 413 }));
        req.destroy();
        return;
      }
      data += chunk;
    });
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); }
      catch { reject(Object.assign(new Error('Invalid JSON body'), { statusCode: 400 })); }
    });
    req.on('error', reject);
  });
}

function cleanMessages(messages) {
  if (!Array.isArray(messages)) return [];
  return messages.slice(-20).filter(message => (
    message && ['system', 'user', 'assistant'].includes(message.role) &&
    typeof message.content === 'string' && message.content.trim().length > 0
  )).map(message => ({
    role: message.role,
    content: message.content.slice(0, 12_000),
  }));
}

async function handleChat(req, res) {
  if (!process.env.OPENROUTER_API_KEY) {
    return json(res, 503, { error: { message: 'OPENROUTER_API_KEY is not configured on Render yet.' } });
  }
  if (!allowed(clientIp(req))) {
    return json(res, 429, { error: { message: 'Too many requests. Please wait a minute and try again.' } });
  }
  try {
    const body = await readBody(req);
    const messages = cleanMessages(body.messages);
    if (!messages.length || messages[messages.length - 1].role !== 'user') {
      return json(res, 400, { error: { message: 'A user message is required.' } });
    }
    const upstream = await fetch(OPENROUTER_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
        'HTTP-Referer': process.env.PUBLIC_URL || `https://${req.headers.host || 'render.com'}`,
        'X-Title': 'Insanity AI',
      },
      body: JSON.stringify({
        model: 'openrouter/free',
        messages,
        temperature: 0.7,
        max_tokens: 700,
      }),
    });
    const data = await upstream.json().catch(() => ({ error: { message: 'OpenRouter returned invalid JSON.' } }));
    return json(res, upstream.status, data);
  } catch (error) {
    console.error('Chat request failed:', error);
    return json(res, error.statusCode || 500, { error: { message: error.message || 'Unexpected server error.' } });
  }
}

function serveIndex(res) {
  const file = path.join(PUBLIC_DIR, 'index.html');
  fs.createReadStream(file).on('error', error => {
    console.error(error);
    if (!res.headersSent) json(res, 500, { error: { message: 'Could not load the site.' } });
  }).pipe(res);
}

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/health') return json(res, 200, { ok: true });
  if (req.method === 'POST' && req.url === '/api/chat') return handleChat(req, res);
  if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    return serveIndex(res);
  }
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Not found');
});

server.listen(PORT, HOST, () => console.log(`Insanity Render server listening on ${HOST}:${PORT}`));
