'use strict';

/**
 * Vektiva SMARWI - local network discovery.
 *
 * @author Marian Lojka <marian.lojka@gmail.com>
 * @license MIT
 */

const os = require('os');
const SmarwiApi = require('./SmarwiApi');

/**
 * Discovery of SMARWI devices on the local network.
 *
 * SMARWI announces itself neither over mDNS nor SSDP, so the only reliable
 * way to find one without asking the user to type an IP address is to ask
 * every host on the local /24 subnet for /statusn.
 *
 * Note: Homey apps run in a container, so os.networkInterfaces() reports the
 * container's own network — not the LAN. The subnet must therefore come from
 * homey.cloud.getLocalAddress(), which the caller passes in as `hint`.
 */

const SCAN_TIMEOUT = 2000; // ms per host
const BATCH_SIZE = 51; // parallel requests — 254 hosts in 5 batches

/** `192.168.1.10:80` / `192.168.1.10` -> `192.168.0` */
function toPrefix(address) {
  const parts = String(address || '').split(':')[0].split('.');
  if (parts.length !== 4) return null;
  if (parts.some((part) => !/^\d+$/.test(part))) return null;
  return parts.slice(0, 3).join('.');
}

/** Interfaces of the machine we run on — the fallback when no hint is given. */
function getInterfacePrefixes() {
  const prefixes = new Set();

  for (const addresses of Object.values(os.networkInterfaces())) {
    for (const address of addresses || []) {
      const isIPv4 = address.family === 'IPv4' || address.family === 4;
      if (!isIPv4 || address.internal) continue;

      const prefix = toPrefix(address.address);
      if (prefix !== null) prefixes.add(prefix);
    }
  }

  return [...prefixes];
}

/**
 * Determines which /24 subnets to scan.
 * @param {string|string[]} [hint] address(es) known to live on the target LAN
 */
function getScanPrefixes(hint) {
  const hints = (Array.isArray(hint) ? hint : [hint])
    .map(toPrefix)
    .filter((prefix) => prefix !== null);

  return hints.length > 0 ? [...new Set(hints)] : getInterfacePrefixes();
}

/**
 * Scans the given /24 subnet(s) for SMARWI devices.
 * @param {object} [opts]
 * @param {string|string[]} [opts.hint] address(es) on the LAN to scan
 * @param {function} [opts.log]
 * @returns {Promise<{devices: Array<{address: string, status: object}>, prefixes: string[]}>}
 */
async function discoverSmarwis({ hint, log = () => {} } = {}) {
  const prefixes = getScanPrefixes(hint);

  if (prefixes.length === 0) {
    log('No IPv4 subnet could be determined, cannot scan');
    return { devices: [], prefixes };
  }

  const hosts = [];
  for (const prefix of prefixes) {
    for (let i = 1; i <= 254; i++) hosts.push(`${prefix}.${i}`);
  }

  log(`Scanning ${hosts.length} addresses on ${prefixes.map((p) => `${p}.0/24`).join(', ')}`);

  const devices = [];

  for (let i = 0; i < hosts.length; i += BATCH_SIZE) {
    const batch = hosts.slice(i, i + BATCH_SIZE);

    // eslint-disable-next-line no-await-in-loop
    const results = await Promise.all(batch.map(async (address) => {
      try {
        const status = await new SmarwiApi(address, { timeout: SCAN_TIMEOUT }).getStatus();
        return { address, status };
      } catch (err) {
        return null;
      }
    }));

    for (const result of results) {
      if (result === null) continue;
      log(`Found SMARWI "${result.status.name}" at ${result.address}`);
      devices.push(result);
    }
  }

  log(`Scan finished, ${devices.length} device(s) found`);

  return { devices, prefixes };
}

module.exports = { discoverSmarwis, getScanPrefixes, getInterfacePrefixes, toPrefix };
