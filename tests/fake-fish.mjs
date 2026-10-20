/* ==========================================================================
   fake-fish.mjs — a local stand-in for the Fish Audio text-to-speech API.

   Same contract as https://api.fish.audio/v1/tts:
     POST /v1/tts
       Authorization: Bearer <key>
       model: <voice model>
       { text, format, prosody: { speed, volume }, reference_id? }
     200 → raw audio bytes
     401/403 → a rejected key, 429 → rate limited, 500 → upstream error

   Why a double: the suite must prove the real request shape (headers, body,
   audio passthrough) without a Fish Audio account or a network call.
   ========================================================================== */

import http from 'node:http';

/** A few bytes that stand in for an MP3 frame — never a real audio file. */
const AUDIO = Buffer.from([0x49, 0x44, 0x33, 0x03, 0x00, 0x00, 0x00, 0x00, 0x0a, 0x2f, 0x61, 0x75, 0x64, 0x69, 0x6f]);

export function startFakeFish({ status = 200, contentType = 'audio/mpeg' } = {}) {
  const state = {
    requests: [],
    status,
    contentType,
    port: 0,
    /** Reset the recorded traffic between scenarios. */
    reset() { state.requests.length = 0; },
  };

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks);
      let body = null;
      try { body = JSON.parse(raw.toString('utf8')); } catch { /* non-JSON */ }

      state.requests.push({
        url: req.url,
        method: req.method,
        authorization: req.headers.authorization || '',
        model: req.headers.model || '',
        contentType: req.headers['content-type'] || '',
        body,
        bytes: raw.byteLength,
      });

      if (state.status !== 200) {
        res.writeHead(state.status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ detail: state.status === 401 ? 'invalid api key' : 'upstream error' }));
        return;
      }

      res.writeHead(200, {
        'Content-Type': state.contentType,
        'Content-Length': String(AUDIO.byteLength),
      });
      res.end(AUDIO);
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      state.port = server.address().port;
      state.close = () => new Promise((done) => server.close(done));
      resolve(state);
    });
  });
}
