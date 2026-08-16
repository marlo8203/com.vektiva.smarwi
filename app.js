'use strict';

/**
 * Vektiva SMARWI - Homey app entry point.
 *
 * @author Marian Lojka <marian.lojka@gmail.com>
 * @license MIT
 */

const Homey = require('homey');

class VektivaApp extends Homey.App {

  async onInit() {
    this.log('Vektiva SMARWI app has been initialized');
  }

}

module.exports = VektivaApp;
