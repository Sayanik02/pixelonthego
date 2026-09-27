# Minecraft Pixel Art Bot v2.0

Builds 500×500 pixel art portraits in Minecraft. Controlled entirely from Aternos console — no need to join the game!

---

## Files

```
minecraft-pixel-bot/
├── config.js           ← ONLY file you edit
├── bot.js              ← Main bot
├── imageProcessor.js   ← Image → blocks
├── blockPalette.js     ← Color matching
├── terrain.js          ← Terrain prep
├── progressManager.js  ← Auto-save
├── package.json
├── progress.json       ← Auto-created
├── skipped.log         ← Auto-created
└── images/
    └── input.png       ← DROP YOUR IMAGE HERE
```

---

## Step 1 — Edit config.js

Open `config.js` and change:
```js
host: 'YOUR_SERVER.aternos.me'  // your real Aternos address
```
That's the only thing you need to change!

---

## Step 2 — Deploy to Railway

1. Go to https://railway.app and make a free account
2. Install Railway CLI on your PC:
   ```
   npm install -g @railway/cli
   ```
3. Open terminal in the `minecraft-pixel-bot` folder
4. Run:
   ```
   railway login
   railway init
   railway up
   ```
5. Bot is now running 24/7 on Railway!

### To update the bot later (after editing config.js):
```
railway up
```

### To add your image to Railway:
Put `input.png` in the `images/` folder BEFORE running `railway up`
The bot will detect it automatically.

---

## Step 3 — OP the bot usernames on Aternos

Go to Aternos Panel → Players → OPs → Add these names:
```
PixelBot_Arjun
PixelBot_Raven
PixelBot_Storm
PixelBot_Blaze
PixelBot_Frost
PixelBot_Ember
PixelBot_Dusk
PixelBot_Nova
PixelBot_Flux
PixelBot_Zion
```

---

## Step 4 — Using the Bot

Everything is controlled from **Aternos Console**:

### Prepare terrain
```
pixel prepare 100 64 200
```
Replace 100 64 200 with the X Y Z coordinates where you want the art.
Bot will:
- Clear trees, hills, grass above that level
- Fill ponds, holes, caves below that level
- Flatten everything into a perfect 500×500 base
- Place a **gold block** at the center for your screenshot reference

### Drop your image
Put your photo in `images/` folder as `input.png`
Bot will announce in console when it detects it.

### Start building
```
pixel start
```
Bot flies to the origin and starts placing blocks row by row.

### Check progress
```
pixel status
```

### Pause
```
pixel stop
```

### Resume after pause or restart
```
pixel resume
```

### Get screenshot coordinates
```
pixel center
```
Bot tells you exactly where to fly for the perfect screenshot.

---

## Taking the Screenshot

1. Type `pixel center` in console to get coordinates
2. Join your Minecraft server
3. Type `/tp @s <centerX> <centerY+400> <centerZ>` to teleport above it
4. Press **F5** for third person
5. Look straight down
6. Press **F1** to hide HUD
7. Turn off clouds and fog in Video Settings
8. Enable shaders for best look
9. Press **F2** to screenshot

---

## Auto-Resume

Bot NEVER stops working:
- PC shuts down → bot on Railway keeps running
- Bot gets kicked → reconnects automatically
- Bot gets banned → switches to next username → rejoins → resumes build
- Server goes down → bot retries every few seconds forever

---

## Config Reference

```js
server.host          // Aternos address
server.port          // Usually 25565
bot.usernames        // Pre-OP'd username list
bot.reconnectDelay   // Ms before reconnect (default 5000)
image.path           // Image file path
image.width/height   // Pixel art size (default 500x500)
build.saveEvery      // Save every N blocks (default 100)
build.placeDelay     // Ms between blocks (default 50)
build.retryAttempts  // Obstacle retries (default 3)
build.retryDelay     // Ms between retries (default 5000)
build.flyHeight      // Height above build area (default 15)
```
