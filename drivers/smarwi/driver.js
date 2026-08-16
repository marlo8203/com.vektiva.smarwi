'use strict';

/**
 * Vektiva SMARWI - driver: pairing and Flow cards.
 *
 * @author Marian Lojka <marian.lojka@gmail.com>
 * @license MIT
 */

const Homey = require('homey');
const { discoverSmarwis } = require('../../lib/discover');

class SmarwiDriver extends Homey.Driver {

  async onInit() {
    this.homey.flow.getActionCard('open_to')
      .registerRunListener(async ({ device, position }) => device.openWindow(position));

    this.homey.flow.getActionCard('close')
      .registerRunListener(async ({ device }) => device.closeWindow());

    this.homey.flow.getActionCard('stop')
      .registerRunListener(async ({ device }) => device.stopWindow());

    this.homey.flow.getActionCard('fix')
      .registerRunListener(async ({ device }) => device.fixWindow());

    this.homey.flow.getActionCard('release')
      .registerRunListener(async ({ device }) => device.releaseWindow());

    this.homey.flow.getActionCard('raw_command')
      .registerRunListener(async ({ device, command }) => device.sendRawCommand(command));

    this.homey.flow.getConditionCard('ridge_inside')
      .registerRunListener(async ({ device }) => device.getCapabilityValue('smarwi_ridge_inside') === true);

    this.homey.flow.getConditionCard('is_fixed')
      .registerRunListener(async ({ device }) => device.getCapabilityValue('smarwi_fixed') === true);
  }

  /**
   * Scans the local network for SMARWI devices.
   * SMARWI supports neither mDNS nor SSDP, so this asks every host on Homey's
   * own /24 subnet for /statusn — which beats making the user type an IP.
   */
  async onPairListDevices() {
    // Homey apps run in a container, so the LAN subnet has to come from Homey
    // itself — os.networkInterfaces() would report the container's network.
    let localAddress = null;
    try {
      localAddress = await this.homey.cloud.getLocalAddress();
      this.log(`Homey local address: ${localAddress}`);
    } catch (err) {
      this.log(`Could not determine Homey's local address: ${err.message}`);
    }

    const { devices, prefixes } = await discoverSmarwis({
      hint: localAddress,
      log: (msg) => this.log(msg),
    });

    if (devices.length === 0 && this.listMqttDevices([]).length === 0) {
      // Thrown so the details end up in the pairing dialog — with no app logs
      // at hand, that is the only diagnostics the user gets to see.
      const scanned = prefixes.length > 0
        ? prefixes.map((prefix) => `${prefix}.0/24`).join(', ')
        : 'nothing (no subnet could be determined)';

      throw new Error(`No SMARWI answered. Homey address: ${localAddress || 'unknown'}, `
        + `scanned: ${scanned}.`);
    }

    const found = devices.map(({ address, status }) => ({
      name: status.name || `SMARWI ${address}`,
      data: { id: status.deviceId || `smarwi-${address}` },
      settings: {
        address,
        // The hex ID from /statusn doubles as the vektiva.online Device ID.
        device_id: status.deviceId || '',
        connection: 'local',
        poll_interval: 5,
        device_name: status.name || '',
        firmware: status.firmware || '',
      },
    }));

    return [...found, ...this.listMqttDevices(found)];
  }

  /**
   * Devices seen on the MQTT broker but not on this network - a SMARWI in
   * another house, for instance. They are paired without an IP address and
   * talk over MQTT only.
   */
  listMqttDevices(found) {
    const mqtt = this.homey.app.getMqtt();
    if (!mqtt) return [];

    const already = new Set(found.map((device) => device.settings.device_id));

    return mqtt.getKnownDevices()
      .filter((entry) => entry.deviceId && !already.has(entry.deviceId))
      .map((entry) => ({
        name: entry.name || `SMARWI ${entry.deviceId}`,
        data: { id: `smarwi-cloud-${entry.deviceId}` },
        settings: {
          address: '',
          device_id: entry.deviceId,
          connection: 'cloud',
          poll_interval: 5,
          device_name: entry.name || '',
          firmware: entry.status ? entry.status.firmware || '' : '',
        },
      }));
  }

}

module.exports = SmarwiDriver;
