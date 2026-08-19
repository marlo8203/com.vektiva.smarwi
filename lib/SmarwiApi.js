'use strict';

/**
 * Vektiva SMARWI - client for the local HTTP API.
 *
 * @author Marian Lojka <marian.lojka@gmail.com>
 * @license MIT
 */

const http = require('http');

/**
 * Minimal client for the Vektiva SMARWI local HTTP API.
 *
 * Docs: https://vektiva.gitlab.io/vektivadocs/api/api.html
 *   - commands: GET http://<ip>/cmd/<command>
 *   - status:   GET http://<ip>/statusn   (key:value lines, LF separated)
 *
 * Deliberately uses only Node core `http` so the app has zero runtime deps
 * and works on every Homey firmware/Node version.
 */

/** SMARWI state codes (`s` field of /statusn). */
const StateCode = {
  ERR_WINDOW_LOCKED: 10, // window is locked to the frame
  ERR_MOVE_TIMEOUT: 20, // move-to-frame-sensor timeout
  ERR_WINDOW_HORIZ: 30, // window opened in horizontal position
  CALIBRATION_1: 110,
  CALIBRATION_2: 120,
  CALIBRATION_3: 130,
  OPENING_START: 200,
  OPENING: 210,
  REOPEN_START: 212,
  REOPEN_PHASE: 214,
  REOPEN_FINAL: 216,
  CLOSING_START: 220,
  CLOSING: 230,
  CLOSING_NICE: 231,
  RECLOSE_START: 232,
  RECLOSE_PHASE: 234,
  IDLE: 250,
};

const isError = (s) => s > 0 && s < 200;
const isOpening = (s) => s >= 200 && s < 220;
const isClosing = (s) => s >= 220 && s < 240;
const isMoving = (s) => isOpening(s) || isClosing(s);
const isIdle = (s) => s === StateCode.IDLE;

/** Turns the 32-bit integer in `ip` into a dotted-quad string. */
function intToIp(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  // SMARWI reports the address in network byte order as a plain integer.
  return [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff].join('.');
}

class SmarwiApi {

  /**
   * @param {string} address IP address or hostname of the SMARWI
   * @param {object} [opts]
   * @param {number} [opts.timeout] request timeout in ms
   */
  constructor(address, opts = {}) {
    this.address = address;
    this.timeout = opts.timeout || 5000;
  }

  setAddress(address) {
    this.address = address;
  }

  /** GET a path on the device, resolving with the response body. */
  _get(path) {
    return new Promise((resolve, reject) => {
      const req = http.get(
        { host: this.address, port: 80, path, timeout: this.timeout },
        (res) => {
          let body = '';
          res.setEncoding('utf8');
          res.on('data', (chunk) => {
            body += chunk;
          });
          res.on('end', () => {
            if (res.statusCode >= 200 && res.statusCode < 300) {
              resolve(body);
            } else {
              reject(new Error(`SMARWI returned HTTP ${res.statusCode}`));
            }
          });
        },
      );

      req.on('timeout', () => {
        req.destroy(new Error('Timeout while talking to SMARWI'));
      });
      req.on('error', reject);
    });
  }

  /**
   * Sends a raw command, e.g. `open`, `open/50`, `close`, `stop`, `fix`.
   * @param {string} command
   */
  async command(command) {
    return this._get(`/cmd/${command}`);
  }

  /** Opens the window; `position` is 1..100 %. */
  async open(position) {
    if (position === undefined || position === null) return this.command('open');
    const pct = Math.min(100, Math.max(1, Math.round(position)));
    return this.command(`open/${pct}`);
  }

  async close() {
    return this.command('close');
  }

  /**
   * Stops the movement.
   * Note: the first `stop` stops movement *and* releases the ridge,
   * a second `stop` fixes the ridge again (SMARWI firmware behaviour).
   */
  async stop() {
    return this.command('stop');
  }

  /** Fixes the window (holds it with the device). */
  async fix() {
    return this.command('fix');
  }

  /**
   * Reads /statusn and returns a parsed status object.
   * @returns {Promise<{raw: object, stateCode: number, errorCode: number,
   *   closed: boolean, ridgeInside: boolean, fixed: boolean, moving: boolean,
   *   opening: boolean, closing: boolean, idle: boolean, error: boolean,
   *   name: string|null, firmware: string|null, rssi: number|null, ip: string|null}>}
   */
  async getStatus() {
    return SmarwiApi.parseStatus(await this._get('/statusn'));
  }

  /**
   * Reads the Finetune settings (`GET /lcfa`).
   *
   * Not documented by Vektiva — found by watching what the device's own web
   * interface requests. Returns e.g. { vpct: 100, ospd: 40, … }.
   * `cvdist` is read-only and reported by the device, `cfdist` is set by the
   * calibration wizard.
   * @returns {Promise<object>}
   */
  async getAdvancedConfig() {
    const body = await this._get('/lcfa');
    const config = {};

    for (const line of body.split('\n')) {
      const idx = line.indexOf(':');
      if (idx <= 0) continue;
      const value = Number.parseInt(line.slice(idx + 1).trim(), 10);
      if (!Number.isNaN(value)) config[line.slice(0, idx).trim()] = value;
    }

    if (Object.keys(config).length === 0) {
      throw new Error('SMARWI returned no Finetune settings');
    }

    return config;
  }

  /**
   * Writes the Finetune settings.
   *
   * The device expects the *complete* set as a multipart upload, exactly like
   * its own web interface sends it, so the given values are merged into what
   * the device currently reports.
   * @param {object} values keys to change, e.g. { ospd: 50 }
   * @param {object} [opts]
   * @param {boolean} [opts.save] true (default) stores it permanently, false only applies it
   */
  async setAdvancedConfig(values, { save = true } = {}) {
    const current = await this.getAdvancedConfig();

    // cvdist is reported by the device but cannot be written back.
    delete current.cvdist;

    const merged = { ...current, ...values };
    // The device's own UI sends the fields in this order; keep it identical.
    const order = ['ospd', 'ofspd', 'orpwr', 'ofpwr', 'ohcpwr', 'ohopwr', 'hdist', 'lwid', 'vpct', 'cfdist'];
    const payload = order
      .filter((key) => merged[key] !== undefined)
      .map((key) => `${key}:${merged[key]}`)
      .join('\n');

    const response = await this._postFile(save ? '/scfa' : '/acfa', payload);

    // The device answers with an empty body on success and with the offending
    // field otherwise (its own UI highlights that input).
    const trimmed = response.trim();
    if (trimmed !== '') {
      throw new Error(`SMARWI rejected the Finetune settings: ${trimmed}`);
    }

    return merged;
  }

  /**
   * Resets the Finetune settings to the factory defaults (`GET /rcfa`), which
   * is what the "Reset to defaults" button of the SMARWI web interface calls.
   *
   * Firmware 3.4.1 answers HTTP 500 to it, so the failure is turned into
   * something the user can act on rather than a raw status code.
   */
  async resetAdvancedConfig() {
    try {
      await this._get('/rcfa');
    } catch (err) {
      throw new Error('This SMARWI does not accept a Finetune reset over the API '
        + `(${err.message}). Use Finetune → Reset to defaults in its own web interface.`);
    }

    return this.getAdvancedConfig();
  }

  /** POSTs `content` as a multipart file upload, the way the SMARWI web UI does. */
  _postFile(path, content, filename = '/afile') {
    const boundary = `----smarwi${Date.now().toString(16)}`;
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\n`
        + `Content-Disposition: form-data; name="data"; filename="${filename}"\r\n`
        + 'Content-Type: application/octet-stream\r\n\r\n'),
      Buffer.from(content, 'utf8'),
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);

    return new Promise((resolve, reject) => {
      const req = http.request({
        host: this.address,
        port: 80,
        path,
        method: 'POST',
        timeout: this.timeout,
        headers: {
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Content-Length': body.length,
        },
      }, (res) => {
        let answer = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          answer += chunk;
        });
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) resolve(answer);
          else reject(new Error(`SMARWI returned HTTP ${res.statusCode}`));
        });
      });

      req.on('timeout', () => req.destroy(new Error('Timeout while talking to SMARWI')));
      req.on('error', reject);
      req.end(body);
    });
  }

  /**
   * Parses the `key:value` status format, which /statusn and the WebSocket
   * both use.
   * @param {string} body
   */
  static parseStatus(body) {
    const raw = {};

    for (const line of String(body).split('\n')) {
      const idx = line.indexOf(':');
      if (idx <= 0) continue;
      raw[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
    }

    if (raw.t === undefined && raw.s === undefined) {
      throw new Error('Unexpected response — is this really a SMARWI?');
    }

    const stateCode = Number.parseInt(raw.s, 10) || 0;
    const errorCode = Number.parseInt(raw.e, 10) || 0;
    // `a` carries the scheduler state: -1..-9 paused, -10 and below "no plans".
    const activity = Number.parseInt(raw.a, 10);

    return {
      raw,
      stateCode,
      errorCode,
      // pos: 'c' = closed, 'o' = open
      closed: raw.pos === 'c',
      // `ok:0` is what the device's own web interface shows as "not ready". It
      // covers everything that stops the device acting on a command, an error
      // included, so it is not a ridge sensor. `ro` is - it says the ridge is out.
      ready: raw.ok !== '0',
      ridgeInside: raw.ro !== '1',
      // The built-in scheduler, shown as "paused" / "no plans" by Vektiva.
      paused: Number.isFinite(activity) && activity < 0 && activity > -10,
      noPlans: Number.isFinite(activity) && activity <= -10,
      fixed: raw.fix === '1',
      opening: isOpening(stateCode),
      closing: isClosing(stateCode),
      moving: isMoving(stateCode),
      idle: isIdle(stateCode),
      error: isError(stateCode) || errorCode > 0,
      name: raw.cid || null,
      firmware: raw.fw || null,
      rssi: raw.rssi !== undefined ? Number.parseInt(raw.rssi, 10) : null,
      ip: raw.ip !== undefined ? intToIp(raw.ip) : null,
      deviceId: raw.id || null,
    };
  }

}

module.exports = SmarwiApi;
module.exports.StateCode = StateCode;
