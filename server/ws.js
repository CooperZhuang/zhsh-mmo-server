'use strict';
/**
 * 纵横四海 · 网游服务器 — WebSocket 实时层（方案A）
 *
 * 零依赖：基于 node:http upgrade + 手写 WebSocket 协议（握手 + 文本帧）。
 * 支持 JSON 消息：{type:'auth',token}/{type:'move',...}/{type:'chat',...}/{type:'ping'}。
 * 与 HTTP API 共用同一个裁决引擎与内存 registry。
 */
const crypto = require('node:crypto');
const { URL } = require('node:url');

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function acceptKey(secWebSocketKey) {
  return crypto.createHash('sha1').update(secWebSocketKey + WS_GUID).digest('base64');
}

/** 最小 WebSocket 帧编码（服务端 -> 客户端），仅文本帧 */
function frameText(str) {
  const payload = Buffer.from(str, 'utf8');
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2); header[0] = 0x81; header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4); header[0] = 0x81; header[1] = 126; header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10); header[0] = 0x81; header[1] = 127; header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

function framePong(payload) {
  const buf = Buffer.isBuffer(payload) ? payload : Buffer.from(payload || '');
  const len = buf.length;
  let header;
  if (len < 126) { header = Buffer.alloc(2); header[0] = 0x8a; header[1] = len; }
  else { header = Buffer.alloc(4); header[0] = 0x8a; header[1] = 126; header.writeUInt16BE(len, 2); }
  return Buffer.concat([header, buf]);
}

function frameClose() {
  return Buffer.from([0x88, 0x00]);
}

class WsConnection {
  constructor(socket) {
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    this.readyState = 0; // CONNECTING
    this.onmessage = null; // 客户端帧回调
  }
  send(str) {
    if (this.readyState !== 1) return;
    try { this.socket.write(frameText(str)); } catch {}
  }
  close() {
    try { this.socket.write(frameClose()); } catch {}
    this.readyState = 3;
    try { this.socket.end(); } catch {}
  }
  /** 处理入站数据：拆帧，仅解析文本帧（0x81），忽略控制帧由上层处理 */
  _onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 2) {
      const b0 = this.buffer[0], b1 = this.buffer[1];
      const opcode = b0 & 0x0f;
      const isFinal = (b0 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let offset = 2;
      if (len === 126) {
        if (this.buffer.length < 4) return;
        len = this.buffer.readUInt16BE(2); offset = 4;
      } else if (len === 127) {
        if (this.buffer.length < 10) return;
        len = Number(this.buffer.readBigUInt64BE(2)); offset = 10;
      }
      const masked = (b1 & 0x80) !== 0;
      let maskKey = null;
      if (masked) {
        if (this.buffer.length < offset + 4) return;
        maskKey = this.buffer.subarray(offset, offset + 4);
        offset += 4;
      }
      if (this.buffer.length < offset + len) return;
      let payload = this.buffer.subarray(offset, offset + len);
      this.buffer = this.buffer.subarray(offset + len);
      if (masked) {
        payload = Buffer.from(payload); // 拷贝后再解掩码
        for (let i = 0; i < payload.length; i++) payload[i] ^= maskKey[i % 4];
      }
      // 控制帧
      if (opcode === 0x8) { this.readyState = 3; return; } // close
      if (opcode === 0x9) { try { this.socket.write(framePong(payload)); } catch {} continue; } // ping
      if (opcode === 0xa) continue; // pong
      // 文本 / 连续帧：仅处理完整文本帧
      if (opcode === 0x1 && isFinal) {
        if (!this.onmessage) continue;
        try { this.onmessage(payload.toString('utf8')); } catch {}
      }
    }
  }
}

/** 为 node:http server 挂载 /ws 升级处理 */
function attachWebSocket(server, { onOpen, onMessage, onClose, verifyToken }) {
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname !== '/ws') {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
      return;
    }
    const key = req.headers['sec-websocket-key'];
    if (!key) { socket.write('HTTP/1.1 400 Bad Request\r\n\r\n'); socket.destroy(); return; }
    const accept = acceptKey(key);
    let token = null;
    const queryToken = url.searchParams.get('token');
    if (queryToken) token = queryToken;
    const authHeader = req.headers['authorization'];
    if (authHeader && authHeader.startsWith('Bearer ')) token = authHeader.slice(7);

    const conn = new WsConnection(socket);
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
    );
    conn.readyState = 1;
    socket.on('data', (c) => {
      conn._onData(c);
      // 处理已入队的消息回调由上层 via conn.onmessage
    });
    socket.on('close', () => { conn.readyState = 3; try { onClose(conn); } catch {} });
    socket.on('error', () => {});
    if (head && head.length) socket.unshift(head);

    try { onOpen(conn, { token, url }); } catch {}
  });
}

module.exports = { attachWebSocket, WsConnection, frameText };
