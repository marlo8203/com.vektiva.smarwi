#!/usr/bin/env node
/**
 * Vektiva SMARWI - command line test of the local API.
 *
 * @author Marian Lojka <marian.lojka@gmail.com>
 * @license MIT
 */

'use strict';

/**
 * Quick check of a SMARWI on the local network — run it from your Mac before
 * installing the app on Homey.
 *
 *   node tools/smarwi-test.js 192.168.1.50            # read status
 *   node tools/smarwi-test.js 192.168.1.50 open/40    # send a command
 */

const SmarwiApi = require('../lib/SmarwiApi');

async function main() {
  const [address, command] = process.argv.slice(2);

  if (!address) {
    console.error('Usage: node tools/smarwi-test.js <ip> [command]');
    process.exit(1);
  }

  const api = new SmarwiApi(address, { timeout: 5000 });

  if (command) {
    console.log(`> /cmd/${command}`);
    console.log(await api.command(command));
  }

  const status = await api.getStatus();
  console.log('\nRaw status:');
  console.log(status.raw);
  console.log('\nParsed:');
  console.log({
    name: status.name,
    firmware: status.firmware,
    stateCode: status.stateCode,
    errorCode: status.errorCode,
    closed: status.closed,
    moving: status.moving,
    opening: status.opening,
    closing: status.closing,
    fixed: status.fixed,
    ridgeInside: status.ridgeInside,
    rssi: status.rssi,
    ip: status.ip,
  });
}

main().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
