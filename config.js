// ============================================================
//   CONFIG — edit only this file
// ============================================================

module.exports = {

  server: {
    host:    'forreal8797869.aternos.me',
    port:    64771,
    version: '1.20.4',
  },

  bot: {
    usernames: [
      'PixelBot_Arjun',
      'PixelBot_Raven',
      'PixelBot_Storm',
      'PixelBot_Blaze',
      'PixelBot_Frost',
      'PixelBot_Ember',
      'PixelBot_Dusk',
      'PixelBot_Nova',
      'PixelBot_Flux',
      'PixelBot_Zion',
    ],
    reconnectDelay:       5000,
    maxReconnectAttempts: 99999,
  },

  image: {
    path:   './images/input.png',
    width:  500,
    height: 500,
  },

  build: {
    saveEvery:     100,
    useOp:         true,  // true = bot is OP -> ultra fast /fill mode (falls back automatically if not OP)
    opDelay:       20,    // ms between /fill commands (raise to 40-60 if server lags/kicks)
    opBandRows:    80,    // rows per forceload band
    placeDelay:    5,     // ms between blocks in non-OP mode
    flyHeight:     3,     // fly just above build level
    retryAttempts: 3,
    retryDelay:    3000,
  },

};
