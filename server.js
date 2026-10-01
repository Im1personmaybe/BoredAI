const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const PORT = Number(process.env.PORT || 10000);
const HOST = '0.0.0.0';
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const TMDB_URL = 'https://api.themoviedb.org/3';
const YOUTUBE_URL = 'https://www.googleapis.com/youtube/v3';
const PUBLIC_DIR = __dirname;
const MAX_BODY = 120_000;
const WINDOW_MS = 60_000;
const MAX_REQUESTS_PER_WINDOW = 20;
const rateBuckets = new Map();
const MODEL_MAP = {
  auto: 'openrouter/free',
  'llama3-8b-8192': 'meta-llama/llama-3.1-8b-instruct:free',
  'gemma-2-9b-it': 'google/gemma-2-9b-it:free',
  'llama-3.3-70b-versatile': 'meta-llama/llama-3.3-70b-instruct:free',
  'llama-3.1-8b-instant': 'meta-llama/llama-3.1-8b-instruct:free',
  'llama-3-70b-8192': 'openrouter/free',
  'deepseek-r1-distill-llama-70b': 'deepseek/deepseek-r1-distill-llama-70b:free',
  'llama-4-maverick-17b-128e-instruct': 'openrouter/free',
};

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
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
    const customPrompt = typeof body.customPrompt === 'string' ? body.customPrompt.trim().slice(0, 4_000) : '';
    const modePrompt = body.mode === 'coder'
      ? 'You are Coder, a precise and practical programming assistant. Give working code and concise explanations. Be direct and avoid filler.'
      : body.mode === 'writer'
        ? 'You are Writer, a skilled editor. Make responses natural, specific, varied, and conversational. Rewrite text for flow and voice while preserving meaning. Do not claim to bypass AI detectors.'
        : customPrompt;
    const requestMessages = modePrompt
      ? [{ role: 'system', content: modePrompt }, ...messages]
      : messages;
    const model = MODEL_MAP[body.model] || MODEL_MAP.auto;
    const upstream = await fetch(OPENROUTER_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
        'HTTP-Referer': process.env.PUBLIC_URL || `https://${req.headers.host || 'render.com'}`,
        'X-Title': 'BoredAI',
      },
      body: JSON.stringify({
        model,
        messages: requestMessages,
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


async function handleApiProxy(req, res, provider) {
  const isTMDB = provider === 'tmdb';
  const envName = isTMDB ? 'TMDB_API_KEY' : 'YOUTUBE_API_KEY';
  const apiKey = process.env[envName];
  if (!apiKey) return json(res, 503, { error: { message: `${envName} is not configured on Render yet.` } });
  if (!allowed(clientIp(req))) return json(res, 429, { error: { message: 'Too many requests. Please wait a minute and try again.' } });
  try {
    const incoming = new URL(req.url, 'http://localhost');
    const prefix = isTMDB ? '/api/tmdb' : '/api/youtube';
    const upstream = isTMDB ? TMDB_URL : YOUTUBE_URL;
    const target = new URL(upstream + incoming.pathname.slice(prefix.length));
    incoming.searchParams.forEach((value, key) => {
      if (key !== 'api_key' && key !== 'key') target.searchParams.append(key, value);
    });
    target.searchParams.set(isTMDB ? 'api_key' : 'key', apiKey);
    const upstreamResponse = await fetch(target);
    const data = await upstreamResponse.json().catch(() => ({ error: { message: 'Provider returned invalid JSON.' } }));
    return json(res, upstreamResponse.status, data);
  } catch (error) {
    console.error(`${provider} proxy request failed:`, error);
    return json(res, 502, { error: { message: `Could not reach ${provider}.` } });
  }
}

function serveBrowser(res) {
  const file = path.join(PUBLIC_DIR, 'browser.html');
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=3600' });
  fs.createReadStream(file).on('error', error => {
    console.error(error);
    if (!res.headersSent) json(res, 500, { error: { message: 'Could not load the browser page.' } });
  }).pipe(res);
}

function serveIndex(res) {
  const file = path.join(PUBLIC_DIR, 'index.html');
  fs.createReadStream(file).on('error', error => {
    console.error(error);
    if (!res.headersSent) json(res, 500, { error: { message: 'Could not load the site.' } });
  }).pipe(res);
}

const server = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') {
    cors(res);
    res.writeHead(204);
    return res.end();
  }
  if (req.method === 'GET' && req.url === '/api/chat') {
    return json(res, 200, { ok: true, message: 'Chat endpoint is online. Send a POST request from the website to chat.' });
  }
  if (req.method === 'GET' && req.url === '/health') return json(res, 200, { ok: true });
  if (req.method === 'GET' && req.url.startsWith('/api/tmdb/')) return handleApiProxy(req, res, 'tmdb');
  if (req.method === 'GET' && req.url.startsWith('/api/youtube/')) return handleApiProxy(req, res, 'youtube');
  if (req.method === 'GET' && req.url === '/browser.html') return serveBrowser(res);
  if (req.method === 'POST' && req.url === '/api/chat') return handleChat(req, res);
  if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    return serveIndex(res);
  }
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Not found');
});

server.listen(PORT, HOST, () => console.log(`BoredAF Render server listening on ${HOST}:${PORT}`));
