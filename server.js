/**
 * Web SSH Proxy — WebSocket-to-SSH tunnel.
 *
 * A tiny, dependency-explicit backend that bridges a browser WebSocket
 * (text/JSON control frames + binary/raw byte frames) to an ssh2 SSH session,
 * streaming raw terminal bytes and ANSI escape codes in both directions.
 *
 * Deploy: copy this file and index.html to the same folder, then:
 *   npm init -y
 *   npm install express express-ws ssh2
 *   PORT=3000 node server.js
 *
 * Render/Railway: Node service, start command `node server.js`, health check GET /health.
 * The frontend (index.html) is served from this same directory via Express static.
 *
 * WARNING: this proxy connects to ANY host the client requests. It is intended
 * for personal/trusted use. Add authentication and an allow-list of hosts before
 * exposing it publicly.
 */

const express = require('express');
const { Client } = require('ssh2');

// express-ws changed its export shape between versions:
// v4: { expressWss } named export   v5: module.exports is the factory function itself.
const expressWsModule = require('express-ws');
const expressWs =
  typeof expressWsModule === 'function'
    ? expressWsModule
    : expressWsModule.expressWss ||
      expressWsModule.default;

const app = express();
// express-ws patches app.listen so the HTTP server also handles WebSocket upgrades.
expressWs(app);

const PORT = parseInt(process.env.PORT || '3000', 10);

// Serve the frontend (index.html) from the same directory.
app.use(express.static(__dirname));

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'web-ssh-proxy' });
});

/**
 * WebSocket endpoint: /ssh
 *
 * Client protocol (JSON text frames):
 *   { type: 'connect', host, port, username, password }
 *   { type: 'disconnect' }
 *   { type: 'resize', cols, rows }
 *
 * Raw terminal input may also be sent as a plain text frame or a binary frame.
 *
 * Server protocol:
 *   { type: 'connected' }          — SSH shell is ready
 *   { type: 'error', message }     — connection or runtime error
 *   { type: 'exit', code }         — shell exited
 *   binary frames                  — raw terminal output bytes (ANSI, UTF-8, …)
 */
app.ws('/ssh', (ws, req) => {
  let ssh = null;
  let stream = null;
  let closed = false;

  const isOpen = () => ws.readyState === ws.OPEN;

  const send = (obj) => {
    if (isOpen()) {
      try {
        ws.send(JSON.stringify(obj));
      } catch (e) {
        // Ignore send errors; cleanup will run on close.
      }
    }
  };

  const cleanup = () => {
    if (closed) return;
    closed = true;
    try {
      if (stream) {
        stream.close();
        stream = null;
      }
    } catch (e) {
      // ignore
    }
    try {
      if (ssh) {
        ssh.end();
        ssh = null;
      }
    } catch (e) {
      // ignore
    }
  };

  ws.on('message', (data, isBinary) => {
    try {
      // Binary frame = raw terminal input bytes from the browser.
      if (isBinary || Buffer.isBuffer(data)) {
        if (stream) stream.write(data);
        return;
      }

      const text = String(data);

      // Control message (JSON).
      try {
        const msg = JSON.parse(text);
        if (msg && typeof msg === 'object') {
          if (msg.type === 'connect') {
            doConnect(msg);
            return;
          }
          if (msg.type === 'disconnect') {
            cleanup();
            return;
          }
          if (msg.type === 'resize' && stream) {
            try {
              // ssh2 setWindow(rows, columns, height, width)
              stream.setWindow(msg.rows, msg.cols);
            } catch (e) {
              // ignore
            }
            return;
          }
        }
      } catch (e) {
        // Not JSON -> fall through and treat as raw terminal input text.
      }

      // Raw terminal input (plain text frame).
      if (stream) stream.write(text);
    } catch (e) {
      send({ type: 'error', message: e.message });
    }
  });

  function doConnect(msg) {
    if (ssh) return; // one session per WebSocket

    const host = msg.host;
    const port = parseInt(msg.port || 22, 10);
    const username = msg.username;
    const password = msg.password;

    if (!host || !username) {
      return send({ type: 'error', message: 'Host and username are required' });
    }

    ssh = new Client();

    ssh.on('ready', () => {
      ssh.shell((err, sshStream) => {
        if (err) {
          ssh = null;
          return send({ type: 'error', message: err.message });
        }

        stream = sshStream;

        // Default terminal geometry; the browser sends a real resize shortly after connect.
        try {
          stream.setWindow(24, 80);
        } catch (e) {
          // ignore
        }

        stream.on('data', (chunk) => {
          if (isOpen()) {
            // Send raw bytes as a binary WebSocket frame.
            ws.send(chunk);
          }
        });

        stream.on('close', (code, _signal, _core) => {
          send({
            type: 'exit',
            code: stream.exitStatus != null ? stream.exitStatus : code != null ? code : 0,
          });
          cleanup();
        });

        stream.on('error', (err) => {
          send({ type: 'error', message: err.message });
        });

        // Small banner so the user immediately sees output when the shell starts.
        stream.write('\r\n\x1b[1;34m● Web SSH session established\x1b[0m\r\n\r\n');

        send({ type: 'connected' });
      });
    });

    ssh.on('error', (err) => {
      ssh = null;
      send({ type: 'error', message: err.message });
    });

    ssh.on('end', () => {
      cleanup();
    });

    try {
      ssh.connect({
        host,
        port,
        username,
        password,
        readyTimeout: 30000,
        // Accept any host key (personal tool). Pin known_hosts for production use.
        hostVerifier: () => true,
      });
    } catch (err) {
      ssh = null;
      send({ type: 'error', message: err.message });
    }
  }

  ws.on('close', cleanup);
  ws.on('error', cleanup);
});

const server = app.listen(PORT, () => {
  console.log(`Web SSH proxy listening on http://0.0.0.0:${PORT}`);
  console.log(`Frontend:   http://0.0.0.0:${PORT}/`);
  console.log(`WebSocket:  ws://0.0.0.0:${PORT}/ssh`);
});

process.on('SIGTERM', () => {
  server.close(() => process.exit(0));
});
