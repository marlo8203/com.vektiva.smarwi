'use strict';

/**
 * Vektiva SMARWI - MQTT client shared by all devices.
 *
 * @author Marian Lojka <marian.lojka@gmail.com>
 * @license MIT
 */

const EventEmitter = require('events');
const mqtt = require('mqtt');
const SmarwiApi = require('./SmarwiApi');

/**
 * One connection serves every paired SMARWI.
 *
 * Docs: https://vektiva.gitlab.io/vektivadocs/api/mqtt.html
 *   prefix          ion/<REMOTE_ID>/%<DEVICE_ID>
 *   <prefix>/status status in the same key:value format as /statusn, retained
 *   <prefix>/online "1" while the device is connected, "0" as its last will
 *   <prefix>/cmd    commands, parameters separated by ";" - e.g. "open;50"
 *
 * The factory broker (broker.vektiva.com) accepts the Remote ID as the user
 * name and the Remote KEY as the password, which is what the SMARWI itself
 * logs in with. A local broker works just as well - point both the device and
 * this client at it.
 */

const DEFAULT_HOST = 'broker.vektiva.com';
const DEFAULT_PORT = 1883;

class SmarwiMqtt extends EventEmitter {

  /**
   * @param {object} opts
   * @param {string} opts.host broker host name
   * @param {number} [opts.port]
   * @param {string} opts.username Remote ID
   * @param {string} opts.password Remote KEY
   * @param {function} [opts.log]
   */
  constructor({ host, port, username, password, log = () => {} } = {}) {
    super();
    this.host = (host || DEFAULT_HOST).trim();
    this.port = port || DEFAULT_PORT;
    this.username = (username || '').trim();
    this.password = (password || '').trim();
    this.log = log;
    this.client = null;
  }

  /** True when both the broker and the credentials are known. */
  isConfigured() {
    return this.host !== '' && this.username !== '';
  }

  get isConnected() {
    return this.client !== null && this.client.connected === true;
  }

  /** Topic prefix of one device. */
  prefix(deviceId) {
    return `ion/${this.username}/%${deviceId}`;
  }

  connect() {
    if (!this.isConfigured()) throw new Error('MQTT is not configured');
    if (this.client) return;

    this.client = mqtt.connect(`mqtt://${this.host}:${this.port}`, {
      username: this.username,
      password: this.password,
      // A stable id keeps the broker from piling up sessions on reconnects.
      clientId: `homey-smarwi-${this.username}-${Math.random().toString(16).slice(2, 8)}`,
      reconnectPeriod: 10000,
      connectTimeout: 15000,
      clean: true,
    });

    this.client.on('connect', () => {
      this.log(`MQTT connected to ${this.host}`);
      // Everything under this account; each device filters by its own id.
      this.client.subscribe(`ion/${this.username}/#`, { qos: 0 }, (err) => {
        if (err) this.log(`MQTT subscribe failed: ${err.message}`);
      });
      this.emit('connect');
    });

    this.client.on('message', (topic, payload) => this._onMessage(topic, payload));
    this.client.on('error', (err) => this.log(`MQTT error: ${err.message}`));
    this.client.on('close', () => this.emit('close'));
  }

  close() {
    if (!this.client) return;
    const client = this.client;
    this.client = null;
    client.removeAllListeners();
    client.end(true);
  }

  /**
   * Sends a command to one device. The MQTT syntax is the same as the HTTP one
   * with ";" instead of "/", so `open/40` becomes `open;40`.
   * @param {string} deviceId
   * @param {string} command
   */
  async publishCommand(deviceId, command) {
    if (!this.isConnected) throw new Error('MQTT is not connected');
    if (!deviceId) throw new Error('This device has no Device ID for MQTT');

    const payload = String(command).replace(/^\/+/, '').split('/').join(';');

    return new Promise((resolve, reject) => {
      this.client.publish(`${this.prefix(deviceId)}/cmd`, payload, { qos: 2 }, (err) => {
        if (err) reject(err);
        else resolve(payload);
      });
    });
  }

  _onMessage(topic, payload) {
    // ion/<user>/%<deviceId>/<what...>
    const parts = topic.split('/');
    if (parts.length < 4 || parts[0] !== 'ion') return;

    const deviceId = parts[2].replace(/^%/, '');
    const what = parts.slice(3).join('/');
    const text = payload.toString();

    if (what === 'online') {
      this.emit('online', { deviceId, online: text.trim() === '1' });
      return;
    }

    if (what === 'status') {
      try {
        this.emit('status', { deviceId, status: SmarwiApi.parseStatus(text) });
      } catch (err) {
        // Not a status payload after all - ignore it.
      }
    }
  }

  /**
   * Connects, waits for the first message of the account and reports what was
   * seen. Used by the connection test on the settings page.
   * @returns {Promise<{ok: boolean, message: string}>}
   */
  static async test({ host, port, username, password, timeout = 12000 }) {
    const client = new SmarwiMqtt({ host, port, username, password });

    if (!client.isConfigured()) {
      return { ok: false, message: 'Fill in the broker and the Remote ID first.' };
    }

    return new Promise((resolve) => {
      const devices = new Set();
      let settled = false;

      const finish = (result) => {
        if (settled) return;
        settled = true;
        client.close();
        resolve(result);
      };

      const timer = setTimeout(() => {
        finish(devices.size > 0
          ? { ok: true, message: `Connected. Devices seen: ${[...devices].join(', ')}.` }
          : { ok: true, message: 'Connected to the broker, but no device reported in yet.' });
      }, timeout);

      client.on('status', ({ deviceId, status }) => {
        devices.add(`${status.name || deviceId} (${deviceId})`);
      });
      client.on('online', ({ deviceId }) => devices.add(deviceId));

      try {
        client.connect();
        client.client.on('error', (err) => {
          clearTimeout(timer);
          finish({ ok: false, message: `${err.message}` });
        });
      } catch (err) {
        clearTimeout(timer);
        finish({ ok: false, message: err.message });
      }
    });
  }

}

module.exports = SmarwiMqtt;
