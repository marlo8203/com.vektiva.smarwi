'use strict';

/**
 * Vektiva SMARWI - WebSocket client for status push.
 *
 * @author Marian Lojka <marian.lojka@gmail.com>
 * @license MIT
 */

const net = require('net');
const crypto = require('crypto');
const EventEmitter = require('events');
const SmarwiApi = require('./SmarwiApi');

/**
 * Minimal WebSocket client for the SMARWI push interface (`ws://<ip>/ws`).
 *
 * The device pushes its status roughly once per second, which is both faster
 * and cheaper than polling /statusn. Implemented against Node's `net` module
 * so the app keeps zero runtime dependencies.
 *
 * Events: `status` (parsed status), `message` (raw text), `open`, `close`, `error`.
 */

const OPCODE = {
  CONTINUATION: 0x0,
  TEXT: 0x1,
  BINARY: 0x2,
  CLOSE: 0x8,
  PING: 0x9,
  PONG: 0xa,
};

const RECONNECT_MIN = 5000;
const RECONNECT_MAX = 60000;
const HANDSHAKE_TIMEOUT = 10000;
// The device sends a status every second; nothing for this long means trouble.
const SILENCE_TIMEOUT = 30000;

class SmarwiSocket extends EventEmitter {

  /**
   * @param {string} address IP address or hostname
   * @param {object} [opts]
   * @param {function} [opts.log]
   */
  constructor(address, { log = () => {} } = {}) {
    super();
    this.address = address;
    this.log = log;

    this.socket = null;
    this.buffer = Buffer.alloc(0);
    this.handshakeDone = false;
    this.closed = false;
    this.reconnectDelay = RECONNECT_MIN;
    this.reconnectTimer = null;
    this.silenceTimer = null;
  }

  /** Opens the connection and keeps it open until close() is called. */
  connect() {
    this.closed = false;
    this._open();
  }

  /** Closes the connection and stops reconnecting. */
  close() {
    this.closed = true;
    this._clearTimers();
    this._destroySocket();
  }

  /** True while the WebSocket is connected and the handshake has completed. */
  get isConnected() {
    return this.socket !== null && !this.socket.destroyed && this.handshakeDone;
  }

  /**
   * Sends a text frame to the device, e.g. `open;50` or `lcfa`.
   * @param {string} text
   */
  send(text) {
    if (!this.isConnected) throw new Error('WebSocket is not connected');
    this.socket.write(SmarwiSocket._encodeFrame(OPCODE.TEXT, Buffer.from(String(text), 'utf8')));
  }

  /* ------------------------------------------------------------------ *
   * Connection handling
   * ------------------------------------------------------------------ */

  _open() {
    this._destroySocket();

    this.handshakeDone = false;
    this.buffer = Buffer.alloc(0);

    const key = crypto.randomBytes(16).toString('base64');
    const socket = net.connect({ host: this.address, port: 80 });
    this.socket = socket;

    socket.setTimeout(HANDSHAKE_TIMEOUT);

    socket.on('connect', () => {
      socket.write(`GET /ws HTTP/1.1\r\n`
        + `Host: ${this.address}\r\n`
        + 'Upgrade: websocket\r\n'
        + 'Connection: Upgrade\r\n'
        + `Sec-WebSocket-Key: ${key}\r\n`
        + 'Sec-WebSocket-Version: 13\r\n\r\n');
    });

    socket.on('timeout', () => {
      // Only guards the handshake; cleared once the connection is up.
      socket.destroy(new Error('WebSocket handshake timed out'));
    });

    socket.on('data', (chunk) => this._onData(chunk));
    socket.on('error', (err) => this.emit('error', err));
    socket.on('close', () => this._onClose());
  }

  _onClose() {
    const wasConnected = this.handshakeDone;
    this.handshakeDone = false;
    this._clearTimers();

    if (wasConnected) this.emit('close');
    if (this.closed) return;

    this.log(`WebSocket closed, reconnecting in ${Math.round(this.reconnectDelay / 1000)}s`);
    this.reconnectTimer = setTimeout(() => this._open(), this.reconnectDelay);
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, RECONNECT_MAX);
  }

  _onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);

    if (!this.handshakeDone) {
      const end = this.buffer.indexOf('\r\n\r\n');
      if (end === -1) return;

      const head = this.buffer.subarray(0, end).toString('latin1');
      this.buffer = this.buffer.subarray(end + 4);

      if (!/^HTTP\/1\.1 101/i.test(head)) {
        this.socket.destroy(new Error(`WebSocket upgrade refused: ${head.split('\r\n')[0]}`));
        return;
      }

      this.handshakeDone = true;
      this.reconnectDelay = RECONNECT_MIN;
      this.socket.setTimeout(0);
      this._resetSilenceTimer();
      this.emit('open');
    }

    this._drainFrames();
  }

  _drainFrames() {
    for (;;) {
      const frame = SmarwiSocket._decodeFrame(this.buffer);
      if (frame === null) return;

      this.buffer = this.buffer.subarray(frame.length);
      this._handleFrame(frame);
    }
  }

  _handleFrame(frame) {
    switch (frame.opcode) {
      case OPCODE.TEXT:
      case OPCODE.CONTINUATION: {
        this._resetSilenceTimer();
        const text = frame.payload.toString('utf8');
        this.emit('message', text);

        try {
          this.emit('status', SmarwiApi.parseStatus(text));
        } catch (err) {
          // Not a status payload (config data, for example) — `message` covers it.
        }
        break;
      }
      case OPCODE.PING:
        this.socket.write(SmarwiSocket._encodeFrame(OPCODE.PONG, frame.payload));
        this._resetSilenceTimer();
        break;
      case OPCODE.PONG:
        this._resetSilenceTimer();
        break;
      case OPCODE.CLOSE:
        this._destroySocket();
        break;
      default:
        break;
    }
  }

  _resetSilenceTimer() {
    if (this.silenceTimer) clearTimeout(this.silenceTimer);
    this.silenceTimer = setTimeout(() => {
      this.log('No WebSocket data for 30s, reconnecting');
      this._destroySocket();
    }, SILENCE_TIMEOUT);
  }

  _clearTimers() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.silenceTimer) {
      clearTimeout(this.silenceTimer);
      this.silenceTimer = null;
    }
  }

  _destroySocket() {
    if (this.socket === null) return;
    const socket = this.socket;
    this.socket = null;
    socket.destroy();
  }

  /* ------------------------------------------------------------------ *
   * Framing (RFC 6455, only what this device needs)
   * ------------------------------------------------------------------ */

  /** Client frames must be masked. */
  static _encodeFrame(opcode, payload) {
    const mask = crypto.randomBytes(4);
    const length = payload.length;

    let header;
    if (length < 126) {
      header = Buffer.alloc(2);
      header[1] = 0x80 | length;
    } else if (length < 65536) {
      header = Buffer.alloc(4);
      header[1] = 0x80 | 126;
      header.writeUInt16BE(length, 2);
    } else {
      header = Buffer.alloc(10);
      header[1] = 0x80 | 127;
      header.writeBigUInt64BE(BigInt(length), 2);
    }
    header[0] = 0x80 | opcode; // FIN + opcode

    const masked = Buffer.from(payload);
    for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i % 4];

    return Buffer.concat([header, mask, masked]);
  }

  /** @returns {{opcode: number, payload: Buffer, length: number}|null} */
  static _decodeFrame(buffer) {
    if (buffer.length < 2) return null;

    const opcode = buffer[0] & 0x0f;
    const masked = (buffer[1] & 0x80) !== 0;
    let length = buffer[1] & 0x7f;
    let offset = 2;

    if (length === 126) {
      if (buffer.length < 4) return null;
      length = buffer.readUInt16BE(2);
      offset = 4;
    } else if (length === 127) {
      if (buffer.length < 10) return null;
      length = Number(buffer.readBigUInt64BE(2));
      offset = 10;
    }

    let mask = null;
    if (masked) {
      if (buffer.length < offset + 4) return null;
      mask = buffer.subarray(offset, offset + 4);
      offset += 4;
    }

    if (buffer.length < offset + length) return null;

    const payload = Buffer.from(buffer.subarray(offset, offset + length));
    if (mask !== null) {
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
    }

    return { opcode, payload, length: offset + length };
  }

}

module.exports = SmarwiSocket;
module.exports.OPCODE = OPCODE;
