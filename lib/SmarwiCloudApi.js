'use strict';

/**
 * Vektiva SMARWI - client for the vektiva.online cloud API.
 *
 * @author Marian Lojka <marian.lojka@gmail.com>
 * @license MIT
 */

const https = require('https');

/**
 * Client for the Vektiva online (cloud) API.
 *
 * Docs: https://vektiva.gitlab.io/vektivadocs/api/api.html
 *   GET https://vektiva.online/api/<REMOTE_ID>/<API_KEY>/<DEVICE_ID>/<command>
 *
 * REMOTE_ID and API_KEY are shared for the whole vektiva.online account
 * (menu "API"), DEVICE_ID is unique per SMARWI.
 *
 * Note: the cloud API only accepts *commands* — there is no status endpoint,
 * so a cloud-only device cannot report its real state back to Homey.
 */

const HOST = 'vektiva.online';

// Response codes observed from the live API (it always answers HTTP 200).
const CODE_UNAUTHENTICATED = 10; // wrong Remote ID or API key
const CODE_UNKNOWN_COMMAND = 20; // credentials fine, command not recognised

// A command that certainly does not exist — used to probe the credentials
// without touching the window.
const PROBE_COMMAND = 'homeyconnectiontest';

class SmarwiCloudApi {

  /**
   * @param {object} opts
   * @param {string} opts.remoteId
   * @param {string} opts.apiKey
   * @param {string} opts.deviceId
   * @param {number} [opts.timeout] request timeout in ms
   */
  constructor({ remoteId, apiKey, deviceId, timeout } = {}) {
    this.remoteId = (remoteId || '').trim();
    this.apiKey = (apiKey || '').trim();
    this.deviceId = (deviceId || '').trim();
    this.timeout = timeout || 10000;
  }

  update({ remoteId, apiKey, deviceId }) {
    if (remoteId !== undefined) this.remoteId = (remoteId || '').trim();
    if (apiKey !== undefined) this.apiKey = (apiKey || '').trim();
    if (deviceId !== undefined) this.deviceId = (deviceId || '').trim();
  }

  /** True when Remote ID, API key and Device ID are all filled in. */
  isConfigured() {
    return this.remoteId !== '' && this.apiKey !== '' && this.deviceId !== '';
  }

  _get(path) {
    return new Promise((resolve, reject) => {
      const req = https.get(
        { host: HOST, port: 443, path, timeout: this.timeout },
        (res) => {
          let body = '';
          res.setEncoding('utf8');
          res.on('data', (chunk) => {
            body += chunk;
          });
          res.on('end', () => {
            if (res.statusCode < 200 || res.statusCode >= 300) {
              reject(new Error(`vektiva.online returned HTTP ${res.statusCode}`));
              return;
            }
            // The API answers HTTP 200 even for failures and reports the real
            // outcome in the body: {"code":10,"message":"Unauthenticated"}.
            resolve(body);
          });
        },
      );

      req.on('timeout', () => {
        req.destroy(new Error('Timeout while talking to vektiva.online'));
      });
      req.on('error', reject);
    });
  }

  /**
   * Sends a raw command, e.g. `open`, `open/50`, `close`, `stop`, `fix`,
   * `prio/10/20/ventilate/50`, `queue/20/open/50`.
   */
  async command(command) {
    if (!this.isConfigured()) {
      throw new Error('The vektiva.online connection is not configured');
    }

    const cmd = String(command).replace(/^\/+/, '');
    const body = await this._get(`/api/${encodeURIComponent(this.remoteId)}`
      + `/${encodeURIComponent(this.apiKey)}/${encodeURIComponent(this.deviceId)}/${cmd}`);

    const result = SmarwiCloudApi.parseResponse(body);
    if (result.code === CODE_UNAUTHENTICATED) {
      throw new Error('vektiva.online rejected the Remote ID / API key');
    }
    if (result.code === CODE_UNKNOWN_COMMAND) {
      throw new Error(`vektiva.online rejected the command "${cmd}"`);
    }

    return body;
  }

  /**
   * Verifies the credentials without moving the window: an unknown command is
   * answered with code 20 when the credentials are accepted, and with code 10
   * when they are not.
   * @returns {Promise<{ok: boolean, message: string}>}
   */
  async testCredentials() {
    if (!this.isConfigured()) {
      return { ok: false, message: 'Fill in Remote ID, API key and a Device ID first.' };
    }

    let body;
    try {
      body = await this._get(`/api/${encodeURIComponent(this.remoteId)}`
        + `/${encodeURIComponent(this.apiKey)}/${encodeURIComponent(this.deviceId)}/${PROBE_COMMAND}`);
    } catch (err) {
      return { ok: false, message: err.message };
    }

    const result = SmarwiCloudApi.parseResponse(body);

    if (result.code === CODE_UNAUTHENTICATED) {
      return { ok: false, message: 'Wrong Remote ID or API key (vektiva.online: Unauthenticated).' };
    }
    if (result.code === CODE_UNKNOWN_COMMAND) {
      return { ok: true, message: 'vektiva.online accepted the credentials.' };
    }

    return { ok: false, message: `Unexpected answer from vektiva.online: ${body}` };
  }

  /** Parses `{"code":10,"message":"…"}`; unparseable bodies get code null. */
  static parseResponse(body) {
    try {
      const parsed = JSON.parse(body);
      return {
        code: typeof parsed.code === 'number' ? parsed.code : null,
        message: parsed.message || '',
      };
    } catch (err) {
      return { code: null, message: String(body || '') };
    }
  }

  async open(position) {
    if (position === undefined || position === null) return this.command('open');
    const pct = Math.min(100, Math.max(1, Math.round(position)));
    return this.command(`open/${pct}`);
  }

  async close() {
    return this.command('close');
  }

  async stop() {
    return this.command('stop');
  }

  async fix() {
    return this.command('fix');
  }

}

module.exports = SmarwiCloudApi;
