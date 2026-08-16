'use strict';

/**
 * Vektiva SMARWI - Web API used by the app settings page.
 *
 * @author Marian Lojka <marian.lojka@gmail.com>
 * @license MIT
 */

const SmarwiApi = require('./lib/SmarwiApi');
const SmarwiCloudApi = require('./lib/SmarwiCloudApi');

/** Finds a paired device by its id and makes sure it is reachable locally. */
function findDevice(homey, deviceId) {
  const devices = homey.drivers.getDriver('smarwi').getDevices();
  const device = devices.find((candidate) => candidate.getData().id === deviceId)
    || (devices.length === 1 ? devices[0] : null);

  if (!device) throw new Error('Pick a SMARWI first');
  if (!device.getLocal()) throw new Error('Finetune needs the local network — set the IP address of this SMARWI');

  return device;
}

module.exports = {

  /**
   * Lists the paired SMARWI devices, so the settings page can link to each
   * device's own web interface (which cannot be embedded — Homey is served
   * over HTTPS and the SMARWI only speaks HTTP).
   */
  async getDevices({ homey }) {
    const devices = homey.drivers.getDriver('smarwi').getDevices();

    return devices
      .map((device) => ({
        id: device.getData().id,
        name: device.getName(),
        address: device.getSetting('address') || '',
      }))
      .filter((device) => device.address !== '');
  },

  /** Reads the Finetune values straight from the device. */
  async getFinetune({ homey, query }) {
    const device = findDevice(homey, query.deviceId);
    return device.getLocal().getAdvancedConfig();
  },

  /**
   * Writes Finetune values.
   * @param {string} body.mode `apply` = only until the next reboot, `save` = permanently
   */
  async setFinetune({ homey, body }) {
    const device = findDevice(homey, body.deviceId);
    const values = {};

    for (const [key, value] of Object.entries(body.values || {})) {
      values[key] = Number(value);
    }

    await device.getLocal().setAdvancedConfig(values, { save: body.mode === 'save' });
    await device.syncAdvancedConfig().catch(() => null);

    return device.getLocal().getAdvancedConfig();
  },

  /** Factory reset of the Finetune values. */
  async resetFinetune({ homey, body }) {
    const device = findDevice(homey, body.deviceId);
    const config = await device.getLocal().resetAdvancedConfig();
    await device.syncAdvancedConfig().catch(() => null);
    return config;
  },

  /**
   * Verifies the vektiva.online credentials entered on the settings page.
   * Sends a deliberately unknown command, so the window never moves.
   */
  async testCloud({ homey, body }) {
    const cloud = new SmarwiCloudApi({
      remoteId: body.remoteId,
      apiKey: body.apiKey,
      deviceId: body.deviceId,
      timeout: 15000,
    });

    const result = await cloud.testCredentials();
    homey.app.log(`Cloud credentials test: ${result.ok ? 'OK' : 'failed'} — ${result.message}`);

    return result;
  },

  /**
   * Verifies that a SMARWI answers on the local network.
   */
  async testLocal({ homey, body }) {
    const address = String(body.address || '').trim();

    if (address === '') {
      return { ok: false, message: 'Enter an IP address first.' };
    }

    try {
      const status = await new SmarwiApi(address, { timeout: 5000 }).getStatus();
      return {
        ok: true,
        message: `${status.name || 'SMARWI'} answered — firmware ${status.firmware}, `
          + `${status.closed ? 'closed' : 'open'}, `
          + `${status.ridgeInside ? 'ridge inside' : 'ridge NOT inside'}, RSSI ${status.rssi} dBm.`,
      };
    } catch (err) {
      homey.app.log(`Local test of ${address} failed: ${err.message}`);
      return { ok: false, message: `${address}: ${err.message}` };
    }
  },

};
