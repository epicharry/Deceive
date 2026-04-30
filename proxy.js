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
    const oldStatus = this.status;
    this.status = status;
    console.log(`[Deceive] Status changed to: ${status}`);
    // Resend last presence with new status for each active connection
    for (const conn of this.activeConnections) {
      if (conn.lastPresence) {
        const rewritten = this._rewritePresence(conn.lastPresence, status);
        if (rewritten) {
          conn.riotSocket.write(rewritten);
          console.log('[ChatProxy] Resent presence with new status');
        }
      }
    }
  }

  setEnabled(enabled) {
    this.enabled = enabled;
    console.log(`[Deceive] Enabled: ${enabled}`);
    if (!enabled) {
      // Resend original presence unmodified
      for (const conn of this.activeConnections) {
        if (conn.lastPresence) {
          conn.riotSocket.write(conn.lastPresence);
          console.log('[ChatProxy] Resent original presence (disabled)');
        }
      }
    } else {
      // Re-apply filtering
      for (const conn of this.activeConnections) {
        if (conn.lastPresence) {
          const rewritten = this._rewritePresence(conn.lastPresence, this.status);
          if (rewritten) {
            conn.riotSocket.write(rewritten);
            console.log('[ChatProxy] Resent filtered presence (enabled)');
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
    const connState = {
      clientBuffer: '',
      serverBuffer: '',
      lastPresence: null,
      riotSocket,
      clientSocket,
    };

    this.activeConnections.push(connState);

    // Client -> Riot (filter presence)
    clientSocket.on('data', (data) => {
      connState.clientBuffer += data.toString('utf-8');
      connState.clientBuffer = this._processOutgoing(connState.clientBuffer, riotSocket, connState);
    });

    // Riot -> Client (pass through entirely)
    riotSocket.on('data', (data) => {
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
      console.log('[ChatProxy] Riot server disconnected');
      clientSocket.destroy();
      cleanup();
    });
  }

  // Process outgoing data (client -> Riot) with presence filtering
  _processOutgoing(buffer, riotSocket, connState) {
    // Handle XMPP stream opening
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

      if (stanza.trimStart().startsWith('<presence')) {
        // Store original presence for resend on status change
        if (!/<presence[^>]+\bto\s*=/.test(stanza)) {
          connState.lastPresence = stanza;
        }

        if (this.enabled) {
          const rewritten = this._rewritePresence(stanza, this.status);
          if (rewritten) {
            riotSocket.write(rewritten);
            console.log('[ChatProxy] Presence rewritten');
          } else {
            console.log('[ChatProxy] Presence blocked');
          }
        } else {
          riotSocket.write(stanza);
        }
      } else {
        riotSocket.write(stanza);
      }
    }

    return buffer;
  }

  // Extract one complete XML stanza from buffer
  _extractStanza(buffer) {
    const trimmed = buffer.trimStart();
    if (!trimmed || !trimmed.startsWith('<')) return null;

    // Handle </stream:stream>
    if (trimmed.startsWith('</stream:stream>')) return '</stream:stream>';

    // Get the tag name
    const tagMatch = trimmed.match(/^<([a-zA-Z_][\w:.-]*)/);
    if (!tagMatch) return null;
    const tagName = tagMatch[1];

    // Check for self-closing: find the first > and see if it's preceded by /
    const firstClose = trimmed.indexOf('>');
    if (firstClose === -1) return null;
    if (trimmed[firstClose - 1] === '/') {
      return trimmed.slice(0, firstClose + 1);
    }

    // Find matching closing tag, handling nesting and CDATA/comments
    const closingTag = `</${tagName}>`;
    let depth = 0;
    let i = 0;
    let inTag = false;

    while (i < trimmed.length) {
      if (trimmed[i] === '<') {
        // Check for closing tag of our root element
        if (trimmed.startsWith(closingTag, i)) {
          if (depth === 1) {
            return trimmed.slice(0, i + closingTag.length);
          }
          depth--;
          i += closingTag.length;
          continue;
        }

        // Check for opening tag of same name
        if (trimmed.startsWith(`<${tagName}`, i)) {
          const afterTag = i + 1 + tagName.length;
          if (afterTag < trimmed.length) {
            const ch = trimmed[afterTag];
            if (ch === ' ' || ch === '>' || ch === '/' || ch === '\n' || ch === '\r' || ch === '\t') {
              // Find end of this opening tag to check self-closing
              const tagEnd = trimmed.indexOf('>', i);
              if (tagEnd === -1) return null;
              if (trimmed[tagEnd - 1] === '/') {
                i = tagEnd + 1;
                continue;
              }
              depth++;
              i = tagEnd + 1;
              continue;
            }
          }
        }

        i++;
      } else {
        i++;
      }
    }

    return null;
  }

  // Rewrite presence stanza - mirrors Deceive's PossiblyRewriteAndResendPresenceAsync
  _rewritePresence(stanza, targetStatus) {
    // If online ("chat"), pass through with minimal changes
    if (targetStatus === 'chat') {
      // Deceive in "chat" mode still rewrites <show> to "chat" and game st to "chat"
      // but only if the original st was NOT "dnd" (do not disturb)
      let modified = stanza;
      const lolSt = this._getElementContent(modified, 'league_of_legends', 'st');
      if (lolSt !== 'dnd') {
        modified = this._replaceElement(modified, 'show', 'chat');
        modified = this._replaceGameSt(modified, 'league_of_legends', 'chat');
      }
      return modified;
    }

    // Directed presence (has "to" attribute) - block it to prevent appearing in lobbies
    if (/<presence[^>]+\bto\s*=/.test(stanza)) {
      return null;
    }

    let modified = stanza;

    // Rewrite <show> to target status
    modified = this._replaceElement(modified, 'show', targetStatus);

    // Rewrite league_of_legends <st> to target status
    modified = this._replaceGameSt(modified, 'league_of_legends', targetStatus);

    // Remove <status> element (the text status message)
    modified = modified.replace(/<status>[\s\S]*?<\/status>/g, '');

    if (targetStatus === 'mobile') {
      // For mobile: remove league_of_legends <p> and <m> elements
      modified = this._removeGameElement(modified, 'league_of_legends', 'p');
      modified = this._removeGameElement(modified, 'league_of_legends', 'm');
    } else {
      // For offline: remove entire league_of_legends element
      modified = this._removeGameBlock(modified, 'league_of_legends');
    }

    // Always remove these game presences
    modified = this._removeGameBlock(modified, 'valorant');
    modified = this._removeGameBlock(modified, 'keystone');
    modified = this._removeGameBlock(modified, 'riot_client');
    modified = this._removeGameBlock(modified, 'bacon');
    modified = this._removeGameBlock(modified, 'lion');

    return modified;
  }

  // Get content of a child element within a game element
  _getElementContent(xml, gameName, elementName) {
    const gameRegex = new RegExp(`<${gameName}>[\\s\\S]*?<\\/${gameName}>`);
    const gameMatch = xml.match(gameRegex);
    if (!gameMatch) return null;

    const elRegex = new RegExp(`<${elementName}>([^<]*)<\\/${elementName}>`);
    const elMatch = gameMatch[0].match(elRegex);
    return elMatch ? elMatch[1] : null;
  }

  // Replace content of a top-level element like <show>
  _replaceElement(xml, elementName, value) {
    const regex = new RegExp(`<${elementName}>[^<]*<\\/${elementName}>`);
    if (regex.test(xml)) {
      return xml.replace(regex, `<${elementName}>${value}</${elementName}>`);
    }
    return xml;
  }

  // Replace <st> within a specific game element
  _replaceGameSt(xml, gameName, value) {
    const gameRegex = new RegExp(`(<${gameName}>)([\\s\\S]*?)(<\\/${gameName}>)`);
    return xml.replace(gameRegex, (match, open, content, close) => {
      const newContent = content.replace(/<st>[^<]*<\/st>/, `<st>${value}</st>`);
      return open + newContent + close;
    });
  }

  // Remove a child element within a game element
  _removeGameElement(xml, gameName, elementName) {
    const gameRegex = new RegExp(`(<${gameName}>)([\\s\\S]*?)(<\\/${gameName}>)`);
    return xml.replace(gameRegex, (match, open, content, close) => {
      const cleaned = content.replace(
        new RegExp(`<${elementName}>[\\s\\S]*?<\\/${elementName}>`), ''
      );
      return open + cleaned + close;
    });
  }

  // Remove an entire game block from within <games>
  _removeGameBlock(xml, gameName) {
    // Handle self-closing: <gameName/>
    xml = xml.replace(new RegExp(`<${gameName}\\s*\\/>`), '');
    // Handle full element: <gameName>...</gameName>
    xml = xml.replace(new RegExp(`<${gameName}>[\\s\\S]*?<\\/${gameName}>`), '');
    // Handle with attributes: <gameName attr="val">...</gameName>
    xml = xml.replace(new RegExp(`<${gameName}\\s[^>]*>[\\s\\S]*?<\\/${gameName}>`), '');
    return xml;
  }
}

function startProxy(options = {}) {
  const proxy = new DeceiveProxy(options);
  return proxy.start().then(() => proxy);
}

module.exports = { DeceiveProxy, startProxy };
