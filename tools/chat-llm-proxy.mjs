/*  Manifest Chat — dev LLM proxy
 *  By Andrew Matlock under MIT license · https://manifestx.dev
 *
 *  Holds the Anthropic key server-side and relays the Messages API SSE stream
 *  to the browser `claude` chat adapter — so the key never reaches the client.
 *  No key set → MOCK mode (streams a canned markdown reply) so the whole
 *  browser→proxy→SSE→onMessagePart→markdown pipeline is testable without one.
 *
 *  Run:   ANTHROPIC_API_KEY=sk-ant-... node tools/chat-llm-proxy.mjs
 *  Mock:  node tools/chat-llm-proxy.mjs           (no key)
 *
 *  Production: this same relay deploys as a Cloudflare Worker (swap http for
 *  the Worker fetch handler, read the key from a secret); the browser adapter
 *  is endpoint-agnostic — point window.CHAT_LLM_ENDPOINT at the Worker.
 */

import http from 'http';
import fs from 'fs';
import path from 'path';

// Resolve the key: shell env var first, then the project's .env — the same file
// authors already use for Appwrite. Read SERVER-SIDE only; never shipped to the
// browser. Use the non-PUBLIC name `ANTHROPIC_API_KEY` so mnfst-run can't inject
// it into window.env (a `PUBLIC_`-prefixed key would leak to every visitor).
function keyFromEnvFiles() {
    for (const f of ['.env', 'src/.env', '../.env'].map(p => path.resolve(p))) {
        try {
            for (const line of fs.readFileSync(f, 'utf8').split(/\r?\n/)) {
                const m = line.match(/^\s*ANTHROPIC_API_KEY\s*=\s*(.+?)\s*$/);
                if (m) return m[1].replace(/^["']|["']$/g, '');
            }
        } catch { }
    }
    return '';
}

const PORT = Number(process.env.PORT || 8799);
const KEY = process.env.ANTHROPIC_API_KEY || keyFromEnvFiles();
const MODEL = process.env.CHAT_PROXY_MODEL || 'claude-haiku-4-5';   // cheap/fast for a docs demo
const CORS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'content-type'
};

function sse(res, obj) { res.write(`event: ${obj.type}\ndata: ${JSON.stringify(obj)}\n\n`); }
const wait = (ms) => new Promise(r => setTimeout(r, ms));

// Canned markdown reply for MOCK mode — exercises bold, lists, and a code fence
// so streaming-markdown rendering can be verified end to end.
const MOCK = `Here's a quick **summary** of what just happened:

- The browser \`claude\` adapter streamed this over SSE
- \`$chat\` assembled it token-by-token via \`onMessagePart\`
- The \`x-markdown\` directive re-rendered each token

\`\`\`js
const ok = true; // no API key needed to prove the pipeline
\`\`\`

Set \`ANTHROPIC_API_KEY\` to get **real** Claude replies.`;

async function streamMock(res) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', ...CORS });
    sse(res, { type: 'message_start', message: { id: 'mock', role: 'assistant', model: 'mock' } });
    sse(res, { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
    const chunks = MOCK.match(/\S+\s*/g) || [MOCK];
    for (const text of chunks) { sse(res, { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }); await wait(45); }
    sse(res, { type: 'content_block_stop', index: 0 });
    sse(res, { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: chunks.length } });
    sse(res, { type: 'message_stop' });
    res.end();
}

async function streamReal(res, payload) {
    const upstream = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': KEY, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({
            model: payload.model || MODEL,
            max_tokens: payload.max_tokens || 1024,
            stream: true,
            system: payload.system || undefined,
            messages: payload.messages || []
        })
    });
    if (!upstream.ok) {
        const body = await upstream.text();
        res.writeHead(upstream.status, { 'Content-Type': 'text/event-stream', ...CORS });
        sse(res, { type: 'error', error: { message: `upstream ${upstream.status}: ${body.slice(0, 300)}` } });
        return res.end();
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', ...CORS });
    for await (const chunk of upstream.body) res.write(chunk);   // passthrough — exact Anthropic SSE
    res.end();
}

http.createServer((req, res) => {
    if (req.method === 'OPTIONS') { res.writeHead(204, CORS); return res.end(); }
    if (req.method !== 'POST' || !req.url.startsWith('/chat')) { res.writeHead(404, CORS); return res.end('not found'); }
    let raw = '';
    req.on('data', d => { raw += d; if (raw.length > 25 * 1024 * 1024) req.destroy(); });   // 25MB cap (attachments)
    req.on('end', async () => {
        let payload = {};
        try { payload = raw ? JSON.parse(raw) : {}; } catch { res.writeHead(400, CORS); return res.end('bad json'); }
        try { await (KEY ? streamReal(res, payload) : streamMock(res)); }
        catch (e) { try { res.writeHead(500, CORS); res.end(String(e && e.message || e)); } catch { } }
    });
}).listen(PORT, () => {
    console.log(`chat-llm-proxy on :${PORT}  model=${MODEL}  mode=${KEY ? 'REAL' : 'MOCK (no ANTHROPIC_API_KEY)'}`);
});
