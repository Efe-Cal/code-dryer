const fs = require('fs');
const path = require('path');
const http = require('http');
const { URL } = require('url');

function loadEnvFile() {
	const envPath = path.join(__dirname, '.env');
	if (!fs.existsSync(envPath)) {
		return;
	}

	const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
	for (const line of lines) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith('#')) {
			continue;
		}

		const separatorIndex = trimmed.indexOf('=');
		if (separatorIndex === -1) {
			continue;
		}

		const key = trimmed.slice(0, separatorIndex).trim();
		const value = trimmed.slice(separatorIndex + 1).trim();
		if (!(key in process.env)) {
			process.env[key] = value;
		}
	}
}

loadEnvFile();

const PORT = Number(process.env.PORT || 3000);
const HACKCLUB_API_KEY = process.env.HACKCLUB_API_KEY;
const RATE_LIMIT_MAX_REQUESTS = Number(process.env.RATE_LIMIT_MAX_REQUESTS || 30);
const RATE_LIMIT_WINDOW_MS = Number(process.env.RATE_LIMIT_WINDOW_MS || 60_000);
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';
const UPSTREAM_URL = 'https://ai.hackclub.com/proxy/v1/embeddings';
const ALLOWED_MODEL = 'openai/text-embedding-3-small';
const rateLimitStore = new Map();

function setCorsHeaders(response) {
	response.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
	response.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
	response.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function sendJson(response, statusCode, payload) {
	setCorsHeaders(response);
	response.writeHead(statusCode, { 'Content-Type': 'application/json' });
	response.end(JSON.stringify(payload));
}

function getClientIp(request) {
	const forwardedFor = request.headers['x-forwarded-for'];
	if (typeof forwardedFor === 'string' && forwardedFor.length > 0) {
		return forwardedFor.split(',')[0].trim();
	}

	return request.socket.remoteAddress || 'unknown';
}

function isRateLimited(ip) {
	const now = Date.now();
	const existing = rateLimitStore.get(ip);
	if (!existing || now > existing.resetAt) {
		rateLimitStore.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
		return false;
	}

	if (existing.count >= RATE_LIMIT_MAX_REQUESTS) {
		return true;
	}

	existing.count += 1;
	return false;
}

function cleanupRateLimitStore() {
	const now = Date.now();
	for (const [ip, entry] of rateLimitStore.entries()) {
		if (now > entry.resetAt) {
			rateLimitStore.delete(ip);
		}
	}
}

async function readJsonBody(request) {
	const chunks = [];

	for await (const chunk of request) {
		chunks.push(chunk);
	}

	const rawBody = Buffer.concat(chunks).toString('utf8');
	if (!rawBody) {
		return {};
	}

	return JSON.parse(rawBody);
}

async function handleEmbeddings(request, response) {
	if (!HACKCLUB_API_KEY) {
		sendJson(response, 500, { error: 'Server is missing HACKCLUB_API_KEY.' });
		return;
	}

	const ip = getClientIp(request);
	if (isRateLimited(ip)) {
		sendJson(response, 429, { error: 'Rate limit exceeded. Please try again later.' });
		return;
	}

	let body;
	try {
		body = await readJsonBody(request);
	} catch {
		sendJson(response, 400, { error: 'Request body must be valid JSON.' });
		return;
	}

	const input = body.input;
	const model = body.model || ALLOWED_MODEL;

	if (typeof input !== 'string' || input.trim().length === 0) {
		sendJson(response, 400, { error: '`input` must be a non-empty string.' });
		return;
	}

	if (model !== ALLOWED_MODEL) {
		sendJson(response, 400, { error: `Only ${ALLOWED_MODEL} is supported.` });
		return;
	}

	try {
		const upstreamResponse = await fetch(UPSTREAM_URL, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'Authorization': `Bearer ${HACKCLUB_API_KEY}`
			},
			body: JSON.stringify({ input, model })
		});

		const responseText = await upstreamResponse.text();
		let upstreamPayload;
		try {
			upstreamPayload = JSON.parse(responseText);
		} catch {
			upstreamPayload = { error: 'Upstream returned non-JSON response.', raw: responseText };
		}

		sendJson(response, upstreamResponse.status, upstreamPayload);
	} catch (error) {
		sendJson(response, 502, {
			error: 'Failed to reach embeddings provider.',
			details: error instanceof Error ? error.message : 'Unknown error'
		});
	}
}

const server = http.createServer(async (request, response) => {
	cleanupRateLimitStore();

	const url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);

	if (request.method === 'OPTIONS') {
		setCorsHeaders(response);
		response.writeHead(204);
		response.end();
		return;
	}

	if (request.method === 'GET' && url.pathname === '/health') {
		sendJson(response, 200, { ok: true });
		return;
	}

	if (request.method === 'POST' && url.pathname === '/embeddings') {
		await handleEmbeddings(request, response);
		return;
	}

	sendJson(response, 404, { error: 'Not found.' });
});

server.listen(PORT, () => {
	console.log(`Embeddings proxy listening on http://localhost:${PORT}`);
});
