#!/usr/bin/env node
/**
 * Vektiva SMARWI - command line test of the cloud API.
 *
 * @author Marian Lojka <marian.lojka@gmail.com>
 * @license MIT
 */

'use strict';

/**
 * Quick check of the vektiva.online (cloud) API — run it from your Mac to
 * verify the credentials before entering them into the Homey app.
 *
 *   node tools/smarwi-cloud-test.js <REMOTE_ID> <API_KEY> <DEVICE_ID> stop
 *
 * Beware: there is no read-only cloud command, so this really does move the
 * window. `stop` is the least intrusive one.
 */

const SmarwiCloudApi = require('../lib/SmarwiCloudApi');

async function main() {
  const [remoteId, apiKey, deviceId, command = 'stop'] = process.argv.slice(2);

  if (!remoteId || !apiKey || !deviceId) {
    console.error('Usage: node tools/smarwi-cloud-test.js <REMOTE_ID> <API_KEY> <DEVICE_ID> [command]');
    process.exit(1);
  }

  const api = new SmarwiCloudApi({ remoteId, apiKey, deviceId });

  console.log(`> https://vektiva.online/api/${remoteId}/***/${deviceId}/${command}`);
  const response = await api.command(command);
  console.log('Response:', response || '(empty)');
}

main().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
