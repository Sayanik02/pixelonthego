// ============================================================
//   MINECRAFT PIXEL ART BOT - CONFIG FILE
//   Edit ONLY this file. Never touch the other files.
// ============================================================

module.exports = {

  server: {
    host: 'forreal8797869.aternos.me',   // <-- Put your Aternos address here
    port: 64771,
    version: '1.20.4',                 // Don't change
  },

  bot: {
    // Pre-OP all these names on Aternos!
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
    reconnectDelay: 5000,
    maxReconnectAttempts: 99999, // basically never stop trying
  },

  image: {
    path: './images/input.png',   // Drop your image here
    width: 500,
    height: 500,
  },

  build: {
    saveEvery: 100,
    placeDelay: 50,               // ms between block placements
    retryAttempts: 3,
    retryDelay: 5000,
    flyHeight: 15,                // how high above terrain to fly while building
  },

};
