'use strict';

/**
 * Vektiva SMARWI - API for the Window dashboard widget.
 *
 * @author Marian Lojka <marian.lojka@gmail.com>
 * @license MIT
 */

/**
 * API for the "Window" dashboard widget.
 *
 * The widget passes the device id chosen in its Devices setting; everything
 * else lives in the driver.
 */

function getDevice(homey, deviceId) {
  const devices = homey.drivers.getDriver('smarwi').getDevices();
  const device = devices.find((candidate) => candidate.getData().id === deviceId)
    || (devices.length === 1 ? devices[0] : null);

  if (!device) throw new Error('Pick a SMARWI in the widget settings');
  return device;
}

module.exports = {

  async getState({ homey, query }) {
    return getDevice(homey, query.deviceId).getWidgetState();
  },

  /**
   * @param {string} body.action `open`, `close`, `stop`, `position`, `fix` or `release`
   * @param {number} [body.value] percentage for `position`
   */
  async sendCommand({ homey, body }) {
    const device = getDevice(homey, body.deviceId);

    switch (body.action) {
      case 'open':
        await device.openFully();
        break;
      case 'close':
        await device.closeWindow();
        break;
      case 'stop':
        await device.stopWindow();
        break;
      case 'fix':
        await device.fixWindow();
        break;
      case 'release':
        await device.releaseWindow();
        break;
      case 'position': {
        const value = Number(body.value);
        // The SMARWI has no "open to 0 %" — that is simply closing.
        if (value <= 1) await device.closeWindow();
        else await device.openWindow(value);
        break;
      }
      default:
        throw new Error(`Unknown action ${body.action}`);
    }

    return device.getWidgetState();
  },

};
