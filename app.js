'use strict';

/**
 * Vektiva SMARWI - Homey app entry point.
 *
 * @author Marian Lojka <marian.lojka@gmail.com>
 * @license MIT
 */

const Homey = require('homey');
const SmarwiMqtt = require('./lib/SmarwiMqtt');

/** Settings that require the MQTT connection to be rebuilt. */
const MQTT_SETTINGS = ['mqtt_enabled', 'mqtt_host', 'remote_id', 'remote_key', 'api_key'];

class VektivaApp extends Homey.App {

  async onInit() {
    this.mqtt = null;

    this.startMqtt();
    this.homey.settings.on('set', (key) => {
      if (MQTT_SETTINGS.includes(key)) this.startMqtt();
    });

    this.log('Vektiva SMARWI app has been initialized');
  }

  async onUninit() {
    this.stopMqtt();
  }

  /**
   * One MQTT connection serves every device. It is optional: without it the
   * app works purely over the local network.
   */
  startMqtt() {
    this.stopMqtt();

    const settings = this.homey.settings;
    if (settings.get('mqtt_enabled') !== true) return;

    const client = new SmarwiMqtt({
      host: settings.get('mqtt_host'),
      username: settings.get('remote_id'),
      // The broker password is the Remote KEY from the device; older setups
      // only filled in the API key, which is often the same value.
      password: settings.get('remote_key') || settings.get('api_key'),
      log: (message) => this.log(message),
    });

    if (!client.isConfigured()) {
      this.log('MQTT is enabled but not configured, skipping');
      return;
    }

    this.mqtt = client;
    client.on('status', (event) => this.homey.emit('smarwi:mqtt:status', event));
    client.on('online', (event) => this.homey.emit('smarwi:mqtt:online', event));
    client.on('connect', () => this.homey.emit('smarwi:mqtt:connect'));
    client.on('close', () => this.homey.emit('smarwi:mqtt:close'));

    try {
      client.connect();
    } catch (err) {
      this.error('Could not start MQTT:', err.message);
      this.mqtt = null;
    }
  }

  stopMqtt() {
    if (!this.mqtt) return;
    this.mqtt.close();
    this.mqtt = null;
  }

  /** The MQTT client when it is connected, otherwise null. */
  getMqtt() {
    return this.mqtt && this.mqtt.isConnected ? this.mqtt : null;
  }

}

module.exports = VektivaApp;
