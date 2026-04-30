const net = require('net');
const tls = require('tls');
const http = require('http');
const https = require('https');
const { URL } = require('url');

const CONFIG_URL = 'https://clientconfig.rpg.riotgames.com';
const GEO_PAS_URL = 'https://riot-geo.pas.si.riotgames.com/pas/v1/service/chat';

const DEFAULT_CHAT_HOST = 'ap.chat.si.riotgames.com';
const DEFAULT_CHAT_PORT = 5223;

class DeceiveProxy {
  constructor(options = {}) {
    this.chatHost = options.chatHost || DEFAULT_CHAT_HOST;
    this.chatPort = options.chatPort || DEFAULT_CHAT_PORT;
    this.chatProxyPort = options.chatProxyPort || 5223;
    this.configProxyPort = options.configProxyPort || 0;
    this.enabled = true;
    this.status = options.status || 'offline';
    this.connections = [];
    this.chatServer = null;
    this.configServer = null;
    this.resolvedChatHost = null;
    this.resolvedChatPort = null;
    this.tlsCert = options.tlsCert || null;
    this.tlsKey = options.tlsKey || null;
  }

  async start() {
    await this._startConfigProxy();
    await this._startChatProxy();
    console.log(`[Deceive] Config proxy on port ${this.configProxyPort}`);
    console.log(`[Deceive] Chat proxy on port ${this.chatProxyPort}`);
    return {
      configPort: this.configProxyPort,
      chatPort: this.chatProxyPort,
    };
  }

  stop() {
    if (this.chatServer) this.chatServer.close();
    if (this.configServer) this.configServer.close();
    for (const conn of this.connections) {
      conn.destroy();
    }
    this.connections = [];
    console.log('[Deceive] Proxy stopped');
  }

  setStatus(status) {
    this.status = status;
    console.log(`[Deceive] Status changed to: ${status}`);
  }

  setEnabled(enabled) {
    this.enabled = enabled;
    console.log(`[Deceive] Enabled: ${enabled}`);
  }

  // --- Config Proxy (HTTP) ---
  _startConfigProxy() {
    return new Promise((resolve) => {
      this.configServer = http.createServer((req, res) => {
        this._handleConfigRequest(req, res);
      });
      this.configServer.listen(this.configProxyPort, '127.0.0.1', () => {
        this.configProxyPort = this.configServer.address().port;
        resolve();
      });
    });
  }

  async _handleConfigRequest(req, res) {
    const targetUrl = CONFIG_URL + req.url;
    console.log(`[ConfigProxy] Proxying: ${targetUrl}`);

    try {
      const headers = {
        'User-Agent': req.headers['user-agent'] || 'Deceive',
      };
      if (req.headers['x-riot-entitlements-jwt']) {
        headers['X-Riot-Entitlements-JWT'] = req.headers['x-riot-entitlements-jwt'];
      }
      if (req.headers['authorization']) {
        headers['Authorization'] = req.headers['authorization'];
      }

      const response = await this._fetchUrl(targetUrl, headers);

      if (response.statusCode < 200 || response.statusCode >= 300) {
        res.writeHead(response.statusCode, { 'Content-Type': 'application/json' });
        res.end(response.body);
        return;
      }

      let config;
      try {
        config = JSON.parse(response.body);
      } catch {
        res.writeHead(response.statusCode, { 'Content-Type': 'application/json' });
        res.end(response.body);
        return;
      }

      // Resolve player affinity to find the correct chat host
      if (config['chat.affinities'] && config['chat.affinity.enabled']) {
        try {
          const affinityHost = await this._resolveAffinity(
            req.headers['authorization'],
            config['chat.affinities']
          );
          if (affinityHost) {
            this.resolvedChatHost = affinityHost;
          }
        } catch (e) {
          console.log('[ConfigProxy] Failed to resolve affinity, using default:', e.message);
        }
      }

      // Save original chat server details
      if (config['chat.host']) {
        if (!this.resolvedChatHost) {
          this.resolvedChatHost = config['chat.host'];
        }
        config['chat.host'] = '127.0.0.1';
      }
      if (config['chat.port']) {
        this.resolvedChatPort = config['chat.port'];
        config['chat.port'] = this.chatProxyPort;
      }

      // Rewrite all affinities to localhost
      if (config['chat.affinities']) {
        for (const key of Object.keys(config['chat.affinities'])) {
          config['chat.affinities'][key] = '127.0.0.1';
        }
      }

      // Update internal chat target
      if (this.resolvedChatHost) {
        this.chatHost = this.resolvedChatHost;
      }
      if (this.resolvedChatPort) {
        this.chatPort = this.resolvedChatPort;
      }

      console.log(`[ConfigProxy] Resolved chat server: ${this.chatHost}:${this.chatPort}`);

      const modified = JSON.stringify(config);
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(modified),
      });
      res.end(modified);
    } catch (e) {
      console.error('[ConfigProxy] Error:', e.message);
      res.writeHead(502, { 'Content-Type': 'text/plain' });
      res.end('Proxy error');
    }
  }

  async _resolveAffinity(authorization, affinities) {
    if (!authorization) return null;

    const response = await this._fetchUrl(GEO_PAS_URL, {
      Authorization: authorization,
    });

    if (response.statusCode !== 200) return null;

    const jwt = response.body;
    const parts = jwt.split('.');
    if (parts.length < 2) return null;

    let payload = parts[1];
    // Fix base64 padding
    while (payload.length % 4 !== 0) {
      payload += '=';
    }

    const decoded = JSON.parse(Buffer.from(payload, 'base64').toString('utf-8'));
    const affinity = decoded.affinity;

    if (affinity && affinities[affinity]) {
      console.log(`[ConfigProxy] Player affinity: ${affinity} -> ${affinities[affinity]}`);
      return affinities[affinity];
    }
    return null;
  }

  _fetchUrl(url, headers) {
    return new Promise((resolve, reject) => {
      const parsed = new URL(url);
      const options = {
        hostname: parsed.hostname,
        port: parsed.port || 443,
        path: parsed.pathname + parsed.search,
        method: 'GET',
        headers,
      };

      const requester = parsed.protocol === 'https:' ? https : http;
      const req = requester.request(options, (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          resolve({
            statusCode: res.statusCode,
            body: Buffer.concat(chunks).toString('utf-8'),
          });
        });
      });
      req.on('error', reject);
      req.end();
    });
  }

  // --- Chat Proxy (TLS MITM) ---
  _startChatProxy() {
    return new Promise((resolve) => {
      if (this.tlsCert && this.tlsKey) {
        this.chatServer = tls.createServer(
          { cert: this.tlsCert, key: this.tlsKey },
          (clientSocket) => this._handleClientConnection(clientSocket)
        );
      } else {
        // Without TLS certs, use raw TCP (for testing or if cert is handled externally)
        this.chatServer = net.createServer((clientSocket) =>
          this._handleClientConnection(clientSocket)
        );
      }

      this.chatServer.listen(this.chatProxyPort, '127.0.0.1', () => {
        this.chatProxyPort = this.chatServer.address().port;
        resolve();
      });
    });
  }

  _handleClientConnection(clientSocket) {
    console.log('[ChatProxy] Client connected');

    const riotSocket = tls.connect(
      {
        host: this.chatHost,
        port: this.chatPort,
        rejectUnauthorized: true,
      },
      () => {
        console.log(`[ChatProxy] Connected to Riot server ${this.chatHost}:${this.chatPort}`);
        this._proxyConnection(clientSocket, riotSocket);
      }
    );

    riotSocket.on('error', (err) => {
      console.error('[ChatProxy] Riot connection error:', err.message);
      clientSocket.destroy();
    });

    clientSocket.on('error', (err) => {
      console.error('[ChatProxy] Client connection error:', err.message);
      riotSocket.destroy();
    });

    this.connections.push(clientSocket, riotSocket);
  }

  _proxyConnection(clientSocket, riotSocket) {
    let clientBuffer = '';
    let serverBuffer = '';

    // Client -> Riot (filter presence)
    clientSocket.on('data', (data) => {
      clientBuffer += data.toString('utf-8');
      clientBuffer = this._processOutgoing(clientBuffer, riotSocket);
    });

    // Riot -> Client (pass through)
    riotSocket.on('data', (data) => {
      serverBuffer += data.toString('utf-8');
      serverBuffer = this._processIncoming(serverBuffer, clientSocket);
    });

    clientSocket.on('close', () => {
      console.log('[ChatProxy] Client disconnected');
      riotSocket.destroy();
    });

    riotSocket.on('close', () => {
      console.log('[ChatProxy] Riot server disconnected');
      clientSocket.destroy();
    });
  }

  // Process outgoing data (client -> Riot) with presence filtering
  _processOutgoing(buffer, riotSocket) {
    // Handle XMPP stream opening (not a complete XML element)
    const streamOpenMatch = buffer.match(/^(<\?xml[^?]*\?>)?\s*(<stream:stream[^>]*>)/);
    if (streamOpenMatch) {
      const streamOpen = streamOpenMatch[0];
      riotSocket.write(streamOpen);
      buffer = buffer.slice(streamOpen.length);
    }

    // Extract and process complete stanzas
    while (true) {
      const stanza = this._extractStanza(buffer);
      if (!stanza) break;

      buffer = buffer.slice(stanza.length);

      if (this.enabled && this._isPresenceStanza(stanza)) {
        const filtered = this._filterPresence(stanza);
        if (filtered) {
          riotSocket.write(filtered);
          console.log('[ChatProxy] Presence rewritten');
        } else {
          console.log('[ChatProxy] Presence blocked');
        }
      } else {
        riotSocket.write(stanza);
      }
    }

    return buffer;
  }

  // Process incoming data (Riot -> client) - pass through
  _processIncoming(buffer, clientSocket) {
    // Handle stream opening
    const streamOpenMatch = buffer.match(/^(<\?xml[^?]*\?>)?\s*(<stream:stream[^>]*>)/);
    if (streamOpenMatch) {
      const streamOpen = streamOpenMatch[0];
      clientSocket.write(streamOpen);
      buffer = buffer.slice(streamOpen.length);
    }

    // Forward complete stanzas
    while (true) {
      const stanza = this._extractStanza(buffer);
      if (!stanza) break;
      buffer = buffer.slice(stanza.length);
      clientSocket.write(stanza);
    }

    return buffer;
  }

  // Extract one complete XML stanza from buffer
  _extractStanza(buffer) {
    const trimmed = buffer.trimStart();
    if (!trimmed || !trimmed.startsWith('<')) return null;

    // Handle self-closing stanzas and stream:stream
    // Handle </stream:stream> closing tag
    const closeStreamMatch = trimmed.match(/^<\/stream:stream>/);
    if (closeStreamMatch) return closeStreamMatch[0];

    // Get the tag name
    const tagMatch = trimmed.match(/^<([a-zA-Z_][\w:.-]*)/);
    if (!tagMatch) return null;
    const tagName = tagMatch[1];

    // Self-closing tag
    const selfCloseRegex = new RegExp(`^<${tagName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^>]*/>`);
    const selfCloseMatch = trimmed.match(selfCloseRegex);
    if (selfCloseMatch) return selfCloseMatch[0];

    // Find matching closing tag, handling nesting
    const closingTag = `</${tagName}>`;
    let depth = 0;
    let i = 0;

    while (i < trimmed.length) {
      if (trimmed[i] === '<') {
        if (trimmed.startsWith(closingTag, i)) {
          if (depth === 1) {
            return trimmed.slice(0, i + closingTag.length);
          }
          depth--;
          i += closingTag.length;
        } else if (trimmed.startsWith(`<${tagName}`, i)) {
          // Check if it's actually this tag (not a prefix match like <presenceX)
          const nextChar = trimmed[i + tagName.length + 1];
          if (nextChar === ' ' || nextChar === '>' || nextChar === '/') {
            // Check for self-closing
            const restSlice = trimmed.slice(i);
            const selfClose = restSlice.indexOf('/>');
            const openClose = restSlice.indexOf('>');
            if (selfClose !== -1 && selfClose < openClose) {
              i += selfClose + 2;
            } else {
              depth++;
              i++;
            }
          } else {
            i++;
          }
        } else {
          i++;
        }
      } else {
        i++;
      }
    }

    // Incomplete stanza, need more data
    return null;
  }

  _isPresenceStanza(stanza) {
    return stanza.trimStart().startsWith('<presence');
  }

  // Filter/rewrite presence stanza to appear offline
  _filterPresence(stanza) {
    if (this.status === 'chat') {
      // If status is "chat" (online), pass presence through unmodified
      return stanza;
    }

    // If presence has a "to" attribute, it's directed (e.g., MUC) - block it for offline
    if (/^<presence[^>]+\bto\s*=/.test(stanza)) {
      return null;
    }

    // Rewrite show element
    let modified = stanza.replace(
      /<show>[^<]*<\/show>/,
      `<show>${this.status}</show>`
    );

    // Remove status message
    modified = modified.replace(/<status>[^<]*<\/status>/, '');

    // Remove game-specific presence elements to appear fully offline
    if (this.status === 'offline') {
      modified = modified.replace(/<games>[\s\S]*?<\/games>/, '<games></games>');
    } else if (this.status === 'mobile') {
      // For mobile, remove game data but keep the games container
      modified = modified.replace(/<games>[\s\S]*?<\/games>/, '<games></games>');
    }

    return modified;
  }
}

function startProxy(options = {}) {
  const proxy = new DeceiveProxy(options);
  return proxy.start().then(() => proxy);
}

module.exports = { DeceiveProxy, startProxy };
