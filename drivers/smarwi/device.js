'use strict';

/**
 * Vektiva SMARWI - device implementation.
 *
 * @author Marian Lojka <marian.lojka@gmail.com>
 * @license MIT
 */

const Homey = require('homey');
const SmarwiApi = require('../../lib/SmarwiApi');
const SmarwiCloudApi = require('../../lib/SmarwiCloudApi');
const SmarwiSocket = require('../../lib/SmarwiSocket');

const DEFAULT_POLL_INTERVAL = 5; // seconds
// With the WebSocket connected the device pushes every change, so polling is
// only a safety net - but the readiness flag (`ok`) matters enough to check it
// regularly even then.
const SOCKET_POLL_INTERVAL = 15; // seconds
// How long a movement waits for the device to become ready before it is dropped,
// so a forgotten command cannot move the window much later.
const PENDING_TTL = 90000; // ms

class SmarwiDevice extends Homey.Device {

  async onInit() {
    const settings = this.getSettings();

    this.local = settings.address ? new SmarwiApi(settings.address, { timeout: 5000 }) : null;
    this.cloud = new SmarwiCloudApi({ deviceId: settings.device_id, timeout: 10000 });

    // SMARWI does not report a real percentage, only open/closed, so we keep
    // track of the position we last asked for.
    this.requestedPosition = null;
    this.wasBlocked = false;
    // The firmware reports no clamp state at all - `ok`/`ro` only say whether
    // the ridge is *in* the device - so it is tracked here. At rest the SMARWI
    // leaves the ridge free, which is why this starts out false.
    this.clamped = false;

    await this.migrateCapabilities();

    this.registerCapabilityListener('windowcoverings_state', (value) => this.onCapabilityState(value));
    this.registerCapabilityListener('windowcoverings_set', (value) => this.onCapabilityPosition(value));

    // A device paired before this setting existed has no value for it.
    if (!this.getSetting('connection')) {
      await this.setSettings({ connection: 'auto' }).catch(this.error);
    }

    this.startSocket();
    this.startMqtt();
    this.restartPolling();
  }

  /** Homey does not add new capabilities to already paired devices by itself. */
  async migrateCapabilities() {
    const wanted = ['smarwi_position', 'smarwi_fixed', 'smarwi_ridge_inside', 'alarm_generic', 'smarwi_rssi'];

    for (const capability of wanted) {
      if (this.hasCapability(capability)) continue;
      try {
        await this.addCapability(capability);
        this.log(`Added capability ${capability}`);
      } catch (err) {
        this.error(`Could not add capability ${capability}:`, err.message);
      }
    }
  }

  async onUninit() {
    this.stopPolling();
    this.stopSocket();
    this.stopMqtt();
    this.stopWatchingReadiness();
  }

  onDeleted() {
    this.stopPolling();
    this.stopSocket();
    this.stopMqtt();
    this.stopWatchingReadiness();
  }

  /* ------------------------------------------------------------------ *
   * MQTT
   * ------------------------------------------------------------------ */

  /**
   * The app keeps one MQTT connection for every device; this only picks out
   * the messages of this SMARWI. MQTT carries the status over the internet
   * too, which neither the local network nor the HTTP cloud API can do.
   */
  startMqtt() {
    this.stopMqtt();

    this.onMqttStatus = ({ deviceId, status }) => {
      if (deviceId !== this.getSetting('device_id')) return;
      this.mqttOnline = true;
      this.applyStatus(status).catch((err) => this.error('MQTT status failed:', err.message));
    };

    this.onMqttOnline = ({ deviceId, online }) => {
      if (deviceId !== this.getSetting('device_id')) return;
      this.mqttOnline = online;
      this.log(`MQTT reports the device as ${online ? 'online' : 'offline'}`);
      if (!online && !this.getLocal()) {
        this.setUnavailable(this.homey.__('errors.unreachable')).catch(this.error);
      }
    };

    this.homey.on('smarwi:mqtt:status', this.onMqttStatus);
    this.homey.on('smarwi:mqtt:online', this.onMqttOnline);
  }

  stopMqtt() {
    if (this.onMqttStatus) this.homey.off('smarwi:mqtt:status', this.onMqttStatus);
    if (this.onMqttOnline) this.homey.off('smarwi:mqtt:online', this.onMqttOnline);
    this.onMqttStatus = null;
    this.onMqttOnline = null;
  }

  /** The shared MQTT client, when it is connected and this device has an ID. */
  getMqtt() {
    if (this.mode === 'local') return null;
    if (!this.getSetting('device_id')) return null;
    return this.homey.app.getMqtt();
  }

  /* ------------------------------------------------------------------ *
   * WebSocket push
   * ------------------------------------------------------------------ */

  /**
   * The device pushes every status change over ws://<ip>/ws, which is both
   * faster and cheaper than polling. Polling stays on as a safety net.
   */
  startSocket() {
    this.stopSocket();

    const address = this.getSetting('address');
    if (!address || this.getSetting('use_websocket') === false || this.mode === 'cloud') return;

    const socket = new SmarwiSocket(address, { log: (msg) => this.log(msg) });
    this.socket = socket;

    socket.on('error', (err) => this.log(`WebSocket error: ${err.message}`));
    socket.on('status', (status) => {
      this.applyStatus(status).catch((err) => this.error('Applying pushed status failed:', err.message));
    });
    // Both events change how often polling is needed.
    socket.on('open', () => {
      this.log('WebSocket connected');
      this.restartPolling();
    });
    socket.on('close', () => this.restartPolling());

    socket.connect();
  }

  stopSocket() {
    if (this.socket) {
      this.socket.removeAllListeners();
      this.socket.close();
      this.socket = null;
    }
  }

  /* ------------------------------------------------------------------ *
   * Transport selection
   * ------------------------------------------------------------------ */

  /**
   * `auto` (local first, cloud as fallback), `cloud_first` (cloud first, local
   * as fallback), `local` or `cloud`.
   */
  get mode() {
    return this.getSetting('connection') || 'auto';
  }

  /** True when vektiva.online is the preferred transport. */
  get prefersCloud() {
    return this.mode === 'cloud' || this.mode === 'cloud_first';
  }

  /** Local API client, or null when no IP address is configured. */
  getLocal() {
    return this.mode === 'cloud' ? null : this.local;
  }

  /** Cloud API client with fresh credentials, or null when not usable. */
  getCloud() {
    if (this.mode === 'local') return null;

    this.cloud.update({
      remoteId: this.homey.settings.get('remote_id'),
      apiKey: this.homey.settings.get('api_key'),
      deviceId: this.getSetting('device_id'),
    });

    return this.cloud.isConfigured() ? this.cloud : null;
  }

  /**
   * A command takes a moment to show up in the device status, and the
   * WebSocket only pushes on change. A few extra reads make the widget and the
   * tile converge quickly even when a push is missed.
   */
  scheduleSettlingPolls() {
    if (!this.getLocal()) return;

    [1200, 3000, 6000, 12000].forEach((delay) => {
      this.homey.setTimeout(() => {
        this.poll().catch(() => null);
      }, delay);
    });
  }

  /**
   * Sends a command over the configured transport(s), preferred one first and
   * the other one as a fallback.
   * @param {string} command everything after /cmd/ , e.g. `open/40`
   */
  async send(command) {
    const local = this.getLocal();
    const cloud = this.getCloud();
    const mqtt = this.getMqtt();

    // MQTT sits between the two: it reaches the device over the internet like
    // the cloud API, but the device answers with a real status afterwards.
    const mqttSender = mqtt
      ? { command: (cmd) => mqtt.publishCommand(this.getSetting('device_id'), cmd) }
      : null;

    const transports = (this.prefersCloud
      ? [['mqtt', mqttSender], ['cloud', cloud], ['local', local]]
      : [['local', local], ['mqtt', mqttSender], ['cloud', cloud]])
      .filter(([, api]) => api !== null);

    if (transports.length === 0) {
      throw new Error(this.homey.__('errors.no_transport'));
    }

    let lastError = null;

    for (const [name, api] of transports) {
      try {
        const result = await api.command(command);
        await this.reportTransport(name);
        this.scheduleSettlingPolls();
        return result;
      } catch (err) {
        lastError = err;
        this.log(`Command over ${name} failed: ${err.message}`);
      }
    }

    throw lastError;
  }

  /** Warns in the Homey UI when the preferred transport had to be skipped. */
  async reportTransport(used) {
    const preferred = this.prefersCloud ? 'cloud' : 'local';

    if (used === preferred) {
      await this.unsetWarning().catch(() => null);
      return;
    }

    if (used === 'mqtt') {
      await this.setWarning(this.homey.__('warnings.using_mqtt')).catch(() => null);
      return;
    }

    const warning = used === 'cloud' ? 'warnings.using_cloud' : 'warnings.using_local';
    await this.setWarning(this.homey.__(warning)).catch(() => null);
  }

  /* ------------------------------------------------------------------ *
   * Polling
   * ------------------------------------------------------------------ */

  restartPolling() {
    this.stopPolling();

    // Only the local API exposes /statusn — a cloud-only device is write-only.
    if (!this.getLocal()) {
      this.setAvailable().catch(this.error);
      return;
    }

    const seconds = this.socket && this.socket.isConnected
      ? SOCKET_POLL_INTERVAL
      : Math.max(2, this.getSetting('poll_interval') || DEFAULT_POLL_INTERVAL);

    this.pollTimer = this.homey.setInterval(() => {
      this.poll().catch((err) => this.error('Poll failed:', err.message));
    }, seconds * 1000);

    this.poll().catch((err) => this.error('Poll failed:', err.message));
  }

  stopPolling() {
    if (this.pollTimer) {
      this.homey.clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  async poll() {
    const local = this.getLocal();
    if (!local) return null;

    let status;
    try {
      status = await local.getStatus();
    } catch (err) {
      if (this.getMqtt() && this.mqttOnline) {
        // MQTT keeps both the state and the commands flowing.
        await this.setAvailable().catch(this.error);
        await this.unsetWarning().catch(() => null);
      } else if (this.getCloud()) {
        // Commands still work through the cloud, so keep the device usable
        // and only warn that the state may be out of date.
        await this.setAvailable().catch(this.error);
        await this.setWarning(this.homey.__('warnings.using_cloud')).catch(() => null);
      } else if (this.getAvailable()) {
        await this.setUnavailable(this.homey.__('errors.unreachable')).catch(this.error);
      }
      throw err;
    }

    return this.applyStatus(status);
  }

  /* ------------------------------------------------------------------ *
   * History and live updates for the dashboard widget
   * ------------------------------------------------------------------ */

  /**
   * Remembers the last opening the window was actually set to, so the widget
   * can offer it as a one-tap preset.
   */
  rememberOpening(position) {
    if (position <= 0 || position === this.getStoreValue('lastOpenPosition')) return;
    this.setStoreValue('lastOpenPosition', position).catch(this.error);
  }

  /** The state the widget renders, also pushed to it on every change. */
  getWidgetState() {
    const position = Math.round((this.getCapabilityValue('windowcoverings_set') || 0) * 100);

    return {
      id: this.getData().id,
      name: this.getName(),
      available: this.getAvailable(),
      position,
      state: this.getCapabilityValue('windowcoverings_state') || 'idle',
      fixed: this.getCapabilityValue('smarwi_fixed') === true,
      ridgeInside: this.getCapabilityValue('smarwi_ridge_inside') === true,
      blocked: this.getCapabilityValue('alarm_generic') === true,
      rssi: this.getCapabilityValue('smarwi_rssi'),
      lastOpenPosition: this.getStoreValue('lastOpenPosition') || 50,
      pending: this.pending ? this.pending.command : null,
      clamped: this.clamped === true,
      address: this.getSetting('address') || '',
      // The four flags the Vektiva interface shows, computed the same way.
      flags: {
        paused: this.lastStatus ? this.lastStatus.paused : false,
        noPlans: this.lastStatus ? this.lastStatus.noPlans : false,
        // Plans exist unless the device reports "no plans".
        hasPlans: this.lastStatus ? !this.lastStatus.noPlans : false,
        fix: this.getCapabilityValue('smarwi_fixed') === true,
        ready: this.getCapabilityValue('smarwi_ridge_inside') === true,
        moving: this.lastStatus ? this.lastStatus.moving : false,
        closed: this.lastStatus ? this.lastStatus.closed : false,
      },
    };
  }

  /** Pushes the new state to every open widget. */
  publishState() {
    try {
      this.homey.api.realtime('smarwi:state', this.getWidgetState());
    } catch (err) {
      // Realtime is best-effort; the widget also polls as a fallback.
    }
  }

  /**
   * Maps a status — polled or pushed over the WebSocket — onto the
   * capabilities.
   */
  async applyStatus(status) {
    if (!this.getAvailable()) await this.setAvailable().catch(this.error);
    await this.unsetWarning().catch(() => null);

    // "Ready" is the flag the device itself shows: the ridge is in the device.
    await this.setCapabilityValue('smarwi_ridge_inside', status.ready).catch(this.error);

    // Moving means the device must be gripping the ridge. It stays gripped
    // afterwards - only a release press lets go - so nothing here sets the
    // flag back to false.
    if (status.moving) this.clamped = true;

    this.lastStatus = status;

    if (status.ready && this.pending) this.runPending();
    await this.setCapabilityValue('smarwi_fixed', status.fixed).catch(this.error);
    await this.setCapabilityValue('alarm_generic', status.error).catch(this.error);
    if (status.rssi !== null && !Number.isNaN(status.rssi)) {
      await this.setCapabilityValue('smarwi_rssi', status.rssi).catch(this.error);
    }

    // Position: SMARWI only reports closed (c) / open (o), so the requested
    // position stands in for the percentage.
    let position;
    if (status.closed) {
      position = 0;
      if (!status.moving && !this.pending) this.requestedPosition = 0;
    } else if (this.requestedPosition !== null && (status.moving || this.pending)) {
      // A movement is under way or waiting for the device: show its target,
      // including 0 while the window is closing but still reported open.
      position = this.requestedPosition;
    } else if (this.requestedPosition !== null && this.requestedPosition > 0) {
      position = this.requestedPosition;
    } else {
      position = 100;
    }

    let state = 'idle';
    if (status.opening) state = 'up';
    else if (status.closing) state = 'down';

    await this.setCapabilityValue('windowcoverings_set', position / 100).catch(this.error);
    await this.setCapabilityValue('windowcoverings_state', state).catch(this.error);
    await this.setCapabilityValue('smarwi_position', position).catch(this.error);

    this.publishState();

    // Fire the "blocked" trigger on the rising edge only.
    if (status.error && !this.wasBlocked) {
      this.homey.flow
        .getDeviceTriggerCard('window_blocked')
        .trigger(this, { state_code: status.stateCode, error_code: status.errorCode })
        .catch(this.error);
    }
    this.wasBlocked = status.error;

    // Keep firmware/name visible in the device settings, and adopt the Device
    // ID the SMARWI reports - it is the same one vektiva.online uses.
    const patch = {};
    if (status.deviceId && !this.getSetting('device_id')) {
      patch.device_id = status.deviceId;
      this.cloud.update({ deviceId: status.deviceId });
    }
    if (status.firmware && status.firmware !== this.getSetting('firmware')) patch.firmware = status.firmware;
    if (status.name && status.name !== this.getSetting('device_name')) patch.device_name = status.name;
    if (Object.keys(patch).length > 0) await this.setSettings(patch).catch(this.error);

    return status;
  }

  async onSettings({ newSettings, changedKeys }) {
    if (changedKeys.includes('address')) {
      this.local = newSettings.address ? new SmarwiApi(newSettings.address, { timeout: 5000 }) : null;
      this.requestedPosition = null;
    }
    if (changedKeys.includes('device_id')) {
      this.cloud.update({ deviceId: newSettings.device_id });
    }

    // Let the new settings take effect (and prove themselves) right away.
    this.homey.setTimeout(() => {
      this.startSocket();
      this.restartPolling();
    }, 500);
  }

  /* ------------------------------------------------------------------ *
   * Capability listeners
   * ------------------------------------------------------------------ */

  async onCapabilityState(value) {
    switch (value) {
      case 'up':
        return this.openWindow(this.requestedPosition && this.requestedPosition > 0
          ? this.requestedPosition
          : 100);
      case 'down':
        return this.closeWindow();
      case 'idle':
      default:
        return this.stopWindow();
    }
  }

  async onCapabilityPosition(value) {
    const pct = Math.round(value * 100);
    if (pct <= 1) return this.closeWindow();
    return this.openWindow(pct);
  }

  /* ------------------------------------------------------------------ *
   * Actions
   * ------------------------------------------------------------------ */

  /**
   * Runs a movement command, or defers it until the device is ready.
   *
   * When the SMARWI reports itself as not ready (`ok:0`) it answers OK to a
   * movement command but only re-engages the ridge - the window stays put and
   * the request is lost. Engaging the ridge takes several seconds, so the
   * command is remembered and sent as soon as the device reports readiness.
   * @param {string} command
   */
  async requestMove(command) {
    if (this.getCapabilityValue('smarwi_ridge_inside') !== false) {
      this.clearPending();
      return this.send(command);
    }

    this.log(`Device is not ready, deferring "${command}" and fixing the ridge`);
    this.pending = { command, at: Date.now() };
    this.publishState();
    this.watchReadiness();

    // Engaging the ridge; applyStatus() fires the deferred command on ok:1.
    return this.send('stop');
  }

  /**
   * Engaging the ridge takes several seconds and does not always come with a
   * push, so poll briskly until the device is ready or the request expires.
   */
  watchReadiness() {
    if (this.pendingTimer) return;

    this.pendingTimer = this.homey.setInterval(() => {
      if (!this.pending) {
        this.stopWatchingReadiness();
        return;
      }
      if (Date.now() - this.pending.at > PENDING_TTL) {
        this.log(`Dropping deferred "${this.pending.command}", the device never got ready`);
        this.clearPending();
        this.publishState();
        return;
      }
      this.poll().catch(() => null);
    }, 800);
  }

  stopWatchingReadiness() {
    if (this.pendingTimer) {
      this.homey.clearInterval(this.pendingTimer);
      this.pendingTimer = null;
    }
  }

  clearPending() {
    this.pending = null;
    this.stopWatchingReadiness();
  }

  /** Called from applyStatus() once the device reports itself ready. */
  runPending() {
    if (!this.pending) return;

    const { command, at } = this.pending;
    this.clearPending();

    if (Date.now() - at > PENDING_TTL) {
      this.log(`Dropping deferred "${command}", the device took too long to get ready`);
      return;
    }

    this.log(`Device is ready, running deferred "${command}"`);
    this.send(command).catch((err) => this.error('Deferred command failed:', err.message));
  }

  async openWindow(position = 100) {
    const pct = Math.min(100, Math.max(1, Math.round(position)));
    this.requestedPosition = pct;
    this.rememberOpening(pct);

    await this.requestMove(`open/${pct}`);
    await this.setCapabilityValue('windowcoverings_state', 'up').catch(this.error);
    await this.setCapabilityValue('windowcoverings_set', pct / 100).catch(this.error);
  }

  async closeWindow() {
    this.requestedPosition = 0;

    await this.requestMove('close');
    await this.setCapabilityValue('windowcoverings_state', 'down').catch(this.error);
    await this.setCapabilityValue('windowcoverings_set', 0).catch(this.error);
  }

  /**
   * Stops a movement.
   *
   * The firmware treats `stop` as a toggle: the first one halts the window and
   * *releases* the ridge, a second one grabs it again. Sending only one leaves
   * the SMARWI reporting "not ready", where the next command gets swallowed.
   * (Same conclusion as the Home Assistant integration, jirutka/hass-smarwi#17.)
   * While nothing is moving there is nothing to stop, and a lone `stop` would
   * just release the ridge - so it is skipped.
   */
  async stopWindow() {
    this.clearPending();

    if (this.lastStatus && !this.lastStatus.moving) {
      this.log('Nothing to stop; not touching the ridge');
      return;
    }

    await this.send('stop');
    await new Promise((resolve) => this.homey.setTimeout(resolve, 400));
    await this.send('stop');

    this.requestedPosition = null;
    await this.setCapabilityValue('windowcoverings_state', 'idle').catch(this.error);
  }

  /**
   * Fixing and releasing the ridge is one and the same command: `stop` toggles
   * it. (`/cmd/fix` is documented but does nothing on firmware 3.4.1, and the
   * device reports the result in `ro`.) So only send it when the wanted state
   * differs from the current one.
   * @param {boolean} fixed
   */
  /**
   * `stop` toggles the clamp and the device reports nothing about it, so the
   * state is tracked here. Standing still the SMARWI keeps the ridge free, so
   * the first press grips it and the next one lets go again.
   * @param {boolean} clamped
   */
  async setRidgeFixed(clamped) {
    if (this.clamped === clamped) return;

    await this.send('stop');
    this.clamped = clamped;
    this.publishState();
  }

  async fixWindow() {
    return this.setRidgeFixed(true);
  }

  async releaseWindow() {
    return this.setRidgeFixed(false);
  }

  async sendRawCommand(command) {
    return this.send(String(command).replace(/^\/+/, ''));
  }

}

module.exports = SmarwiDevice;
