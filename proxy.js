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
    this.chatProxyPort = options.chatProxyPort || 0;
    this.configProxyPort = options.configProxyPort || 0;
    this.enabled = true;
    this.status = options.status || 'offline';
    this.connections = [];
    this.activeConnections = [];
    this.chatServer = null;
    this.configServer = null;
    this.resolvedChatHost = null;
    this.resolvedChatPort = null;
    this.pfxBuffer = options.pfxBuffer || null;
    this.tlsCert = options.tlsCert || null;
    this.tlsKey = options.tlsKey || null;
  }

  async start() {
    await this._startChatProxy();
    await this._startConfigProxy();
    console.log(`[Deceive] Chat proxy on port ${this.chatProxyPort}`);
    console.log(`[Deceive] Config proxy on port ${this.configProxyPort}`);
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
    this.activeConnections = [];
    console.log('[Deceive] Proxy stopped');
  }

  setStatus(status) {
    this.status = status;
    console.log(`[Deceive] Status changed to: ${status}`);
    for (const conn of this.activeConnections) {
      if (conn.lastPresence) {
        const rewritten = this._rewritePresence(conn.lastPresence, status);
        if (rewritten) {
          conn.riotSocket.write(rewritten);
          console.log('[ChatProxy] Resent presence with new status:', status);
        }
      }
    }
  }

  setEnabled(enabled) {
    this.enabled = enabled;
    console.log(`[Deceive] Enabled: ${enabled}`);
    for (const conn of this.activeConnections) {
      if (conn.lastPresence) {
        if (!enabled) {
          conn.riotSocket.write(conn.lastPresence);
          console.log('[ChatProxy] Resent original presence (disabled)');
        } else {
          const rewritten = this._rewritePresence(conn.lastPresence, this.status);
          if (rewritten) {
            conn.riotSocket.write(rewritten);
            console.log('[ChatProxy] Resent filtered presence (re-enabled)');
          }
        }
      }
    }
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

      if (config['chat.affinities']) {
        for (const key of Object.keys(config['chat.affinities'])) {
          config['chat.affinities'][key] = '127.0.0.1';
        }
      }

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
      let tlsOptions = null;

      if (this.pfxBuffer) {
        tlsOptions = { pfx: this.pfxBuffer, passphrase: '' };
      } else if (this.tlsCert && this.tlsKey) {
        tlsOptions = { cert: this.tlsCert, key: this.tlsKey };
      }

      if (tlsOptions) {
        this.chatServer = tls.createServer(tlsOptions, (clientSocket) =>
          this._handleClientConnection(clientSocket)
        );
      } else {
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
    console.log('[ChatProxy] New client connection');

    const riotSocket = tls.connect(
      {
        host: this.chatHost,
        port: this.chatPort,
        rejectUnauthorized: true,
      },
      () => {
        console.log(`[ChatProxy] Connected to Riot: ${this.chatHost}:${this.chatPort}`);
        this._proxyConnection(clientSocket, riotSocket);
      }
    );

    riotSocket.on('error', (err) => {
      console.error('[ChatProxy] Riot socket error:', err.message);
      clientSocket.destroy();
    });

    clientSocket.on('error', (err) => {
      console.error('[ChatProxy] Client socket error:', err.message);
      riotSocket.destroy();
    });

    this.connections.push(clientSocket, riotSocket);
  }

  _proxyConnection(clientSocket, riotSocket) {
    const connState = {
      lastPresence: null,
      riotSocket,
      clientSocket,
      outBuffer: '',
    };

    this.activeConnections.push(connState);

    // CLIENT -> RIOT: Intercept, check for presence, rewrite if needed
    // This mirrors Deceive's IncomingLoopAsync approach:
    // Read chunk, if it contains "<presence" and enabled, rewrite. Otherwise forward as-is.
    clientSocket.on('data', (data) => {
      const content = data.toString('utf-8');
      console.log(`[DEBUG C->S] ${content.length} bytes: ${content.substring(0, 200)}${content.length > 200 ? '...' : ''}`);

      // Accumulate in buffer
      connState.outBuffer += content;

      // Process buffer
      this._processClientBuffer(connState);
    });

    // RIOT -> CLIENT: Pass through completely untouched (raw bytes)
    riotSocket.on('data', (data) => {
      const preview = data.toString('utf-8');
      console.log(`[DEBUG S->C] ${data.length} bytes: ${preview.substring(0, 200)}${preview.length > 200 ? '...' : ''}`);
      clientSocket.write(data);
    });

    const cleanup = () => {
      const idx = this.activeConnections.indexOf(connState);
      if (idx !== -1) this.activeConnections.splice(idx, 1);
    };

    clientSocket.on('close', () => {
      console.log('[ChatProxy] Client disconnected');
      riotSocket.destroy();
      cleanup();
    });

    riotSocket.on('close', () => {
      console.log('[ChatProxy] Riot disconnected');
      clientSocket.destroy();
      cleanup();
    });
  }

  _processClientBuffer(connState) {
    const { riotSocket } = connState;
    let buffer = connState.outBuffer;

    // If buffer doesn't contain any presence, check if we can forward it all
    if (!buffer.includes('<presence')) {
      // No presence in the buffer at all - forward everything
      // But check: could we be mid-stanza where <presence might arrive in next chunk?
      // Only hold back if buffer ends with a partial tag that could become <presence
      const lastLt = buffer.lastIndexOf('<');
      if (lastLt === -1) {
        // No XML tag start at all, forward everything
        riotSocket.write(buffer);
        connState.outBuffer = '';
        return;
      }

      const trailing = buffer.slice(lastLt);
      // If the trailing partial could potentially be the start of <presence...
      if ('<presence'.startsWith(trailing) && trailing !== '<presence'.slice(0, trailing.length) === false) {
        // Actually let's simplify: if trailing is a complete tag (has >) forward all
        if (trailing.includes('>')) {
          riotSocket.write(buffer);
          connState.outBuffer = '';
          return;
        }
        // Trailing is an incomplete tag - hold it back, forward the rest
        const safe = buffer.slice(0, lastLt);
        if (safe.length > 0) riotSocket.write(safe);
        connState.outBuffer = trailing;
        return;
      }

      // The partial tag is not going to become <presence, forward everything
      if (trailing.includes('>')) {
        riotSocket.write(buffer);
        connState.outBuffer = '';
        return;
      }
      // Incomplete non-presence tag, hold just the fragment
      const safe = buffer.slice(0, lastLt);
      if (safe.length > 0) riotSocket.write(safe);
      connState.outBuffer = trailing;
      return;
    }

    // Buffer contains <presence - we need to find the complete presence stanza
    const presStart = buffer.indexOf('<presence');

    // Forward everything before the presence start
    if (presStart > 0) {
      const before = buffer.slice(0, presStart);
      riotSocket.write(before);
      console.log(`[DEBUG] Forwarded ${before.length} bytes before presence`);
      buffer = buffer.slice(presStart);
    }

    // Try to find the end of the presence stanza
    // Check self-closing first
    const selfCloseEnd = this._findSelfClose(buffer, 'presence');
    if (selfCloseEnd !== -1) {
      const stanza = buffer.slice(0, selfCloseEnd);
      this._handlePresenceStanza(stanza, connState);
      connState.outBuffer = buffer.slice(selfCloseEnd);
      // Recurse to process remaining buffer
      if (connState.outBuffer.length > 0) {
        this._processClientBuffer(connState);
      }
      return;
    }

    // Find </presence>
    const closeTag = '</presence>';
    const closeIdx = buffer.indexOf(closeTag);
    if (closeIdx !== -1) {
      const end = closeIdx + closeTag.length;
      const stanza = buffer.slice(0, end);
      this._handlePresenceStanza(stanza, connState);
      connState.outBuffer = buffer.slice(end);
      // Recurse to process remaining buffer
      if (connState.outBuffer.length > 0) {
        this._processClientBuffer(connState);
      }
      return;
    }

    // Presence stanza not yet complete, keep buffering
    connState.outBuffer = buffer;
    console.log(`[DEBUG] Buffering incomplete presence (${buffer.length} bytes)`);
  }

  _findSelfClose(buffer, tagName) {
    // Find /> before any > that isn't />
    const tagStart = buffer.indexOf(`<${tagName}`);
    if (tagStart === -1) return -1;

    let i = tagStart + tagName.length + 1;
    while (i < buffer.length) {
      if (buffer[i] === '>') {
        if (buffer[i - 1] === '/') {
          return i + 1;
        }
        // Found > without / before it - it's an opening tag, not self-closing
        return -1;
      }
      i++;
    }
    return -1;
  }

  _handlePresenceStanza(stanza, connState) {
    const { riotSocket } = connState;

    // Store last non-directed presence for resend on status change
    if (!/<presence[^>]+\bto\s*=/.test(stanza)) {
      connState.lastPresence = stanza;
    }

    if (!this.enabled) {
      // Not enabled - pass through unmodified
      riotSocket.write(stanza);
      console.log(`[ChatProxy] Presence forwarded (disabled) ${stanza.length} bytes`);
      return;
    }

    const rewritten = this._rewritePresence(stanza, this.status);
    if (rewritten) {
      riotSocket.write(rewritten);
      console.log(`[ChatProxy] Presence REWRITTEN (${this.status}): ${rewritten.substring(0, 150)}...`);
    } else {
      console.log(`[ChatProxy] Presence BLOCKED`);
    }
  }

  // Rewrite presence stanza - mirrors Deceive's PossiblyRewriteAndResendPresenceAsync
  _rewritePresence(stanza, targetStatus) {
    if (targetStatus === 'chat') {
      // Online mode - rewrite show/st to chat but keep everything else
      let modified = stanza;
      const lolSt = this._getNestedContent(modified, 'league_of_legends', 'st');
      if (lolSt !== 'dnd') {
        modified = this._replaceTopElement(modified, 'show', 'chat');
        modified = this._replaceNestedElement(modified, 'league_of_legends', 'st', 'chat');
      }
      return modified;
    }

    // Directed presence (has "to" attribute) - block it
    if (/<presence[^>]+\bto\s*=/.test(stanza)) {
      return null;
    }

    let modified = stanza;

    // Rewrite <show>
    modified = this._replaceTopElement(modified, 'show', targetStatus);

    // Rewrite league_of_legends <st>
    modified = this._replaceNestedElement(modified, 'league_of_legends', 'st', targetStatus);

    // Remove <status> element
    modified = modified.replace(/<status>[\s\S]*?<\/status>/g, '');

    if (targetStatus === 'mobile') {
      // Mobile: remove <p> and <m> from league_of_legends
      modified = this._removeNestedElement(modified, 'league_of_legends', 'p');
      modified = this._removeNestedElement(modified, 'league_of_legends', 'm');
    } else {
      // Offline: remove entire league_of_legends block
      modified = this._removeBlock(modified, 'league_of_legends');
    }

    // Remove game-specific blocks
    modified = this._removeBlock(modified, 'valorant');
    modified = this._removeBlock(modified, 'keystone');
    modified = this._removeBlock(modified, 'riot_client');
    modified = this._removeBlock(modified, 'bacon');
    modified = this._removeBlock(modified, 'lion');

    return modified;
  }

  _getNestedContent(xml, parent, child) {
    const parentMatch = xml.match(new RegExp(`<${parent}>[\\s\\S]*?<\\/${parent}>`));
    if (!parentMatch) return null;
    const childMatch = parentMatch[0].match(new RegExp(`<${child}>([^<]*)<\\/${child}>`));
    return childMatch ? childMatch[1] : null;
  }

  _replaceTopElement(xml, name, value) {
    return xml.replace(
      new RegExp(`<${name}>[^<]*<\\/${name}>`),
      `<${name}>${value}</${name}>`
    );
  }

  _replaceNestedElement(xml, parent, child, value) {
    const re = new RegExp(`(<${parent}>)([\\s\\S]*?)(<\\/${parent}>)`);
    return xml.replace(re, (match, open, content, close) => {
      const newContent = content.replace(
        new RegExp(`<${child}>[^<]*<\\/${child}>`),
        `<${child}>${value}</${child}>`
      );
      return open + newContent + close;
    });
  }

  _removeNestedElement(xml, parent, child) {
    const re = new RegExp(`(<${parent}>)([\\s\\S]*?)(<\\/${parent}>)`);
    return xml.replace(re, (match, open, content, close) => {
      const cleaned = content.replace(new RegExp(`<${child}>[\\s\\S]*?<\\/${child}>`), '');
      return open + cleaned + close;
    });
  }

  _removeBlock(xml, name) {
    xml = xml.replace(new RegExp(`<${name}\\s*\\/>`), '');
    xml = xml.replace(new RegExp(`<${name}>[\\s\\S]*?<\\/${name}>`), '');
    xml = xml.replace(new RegExp(`<${name}\\s[^>]*>[\\s\\S]*?<\\/${name}>`), '');
    return xml;
  }
}

function startProxy(options = {}) {
  const proxy = new DeceiveProxy(options);
  return proxy.start().then(() => proxy);
}

module.exports = { DeceiveProxy, startProxy };
