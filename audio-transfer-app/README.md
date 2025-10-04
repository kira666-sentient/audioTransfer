# Audio Transfer App

A simple and elegant audio streaming application built with **JavaScript + Bootstrap + Node.js**. Stream audio across your local network with a clean, responsive interface.

## 🚀 Features

- **Real-time Audio Streaming** - Stream from microphone, system audio, or files
- **Device Discovery** - Automatically find devices on your network
- **Multiple Quality Settings** - From 64kbps to 320kbps
- **Responsive Design** - Works on desktop, tablet, and mobile
- **Bootstrap UI** - Clean, modern interface with dark theme
- **Socket.IO Backend** - Real-time communication
- **Multi-listener Support** - Multiple devices can listen to one stream

## 🛠️ Technology Stack

- **Frontend**: HTML5, CSS3, JavaScript ES6+, Bootstrap 5
- **Backend**: Node.js, Express, Socket.IO
- **Audio**: Web Audio API, WebRTC
- **Styling**: Bootstrap 5 + Custom CSS

## 📦 Installation

1. **Clone the repository**
   ```bash
   git clone <repository-url>
   cd audio-transfer-app
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Start the server**
   ```bash
   npm start
   ```

4. **Open in browser**
   - Local: `http://localhost:3001`
   - Network: `http://[your-ip]:3001`

## 🎵 How to Use

### Streaming Audio
1. Go to the **Stream** tab
2. Select audio source (Microphone/System Audio)
3. Choose quality setting (Low/Medium/High/Ultra)
4. Click **Start Streaming**
5. Share your network IP with others

### Listening to Audio
1. Go to the **Play** tab
2. Click **Refresh** to discover devices
3. Click **Listen** on devices showing "🔴 LIVE"
4. Audio will play automatically

## 📱 Supported Platforms

### Audio Sources
- **Microphone**: All modern browsers
- **System Audio**: Chrome 72+, Edge 79+
- **File Upload**: Coming soon

### Browsers
- Chrome 72+ (Full support)
- Firefox 66+ (Microphone only)
- Safari 13+ (Microphone only)
- Edge 79+ (Full support)

## 🔧 Configuration

### Environment Variables
```bash
PORT=3001  # Server port (default: 3001)
```

### Audio Quality Settings
- **Low**: 64kbps, 22.05kHz
- **Medium**: 128kbps, 44.1kHz (default)
- **High**: 256kbps, 44.1kHz
- **Ultra**: 320kbps, 48kHz

## 🏗️ Architecture

```
┌─────────────┐    WebSocket    ┌─────────────┐
│   Client A  │◄────────────────┤   Server    │
│ (Streamer)  │                 │ (Node.js)   │
└─────────────┘                 └─────────────┘
                                       ▲
                WebSocket              │
┌─────────────┐    Audio         ┌─────▼─────┐
│   Client B  │◄─────────────────│   Client C│
│ (Listener)  │     Relay        │(Listener) │
└─────────────┘                  └───────────┘
```

## 📚 Documentation

- [Server Documentation](./docs/SERVER.md) - Complete server-side documentation
- [Client Documentation](./docs/CLIENT.md) - Client-side functionality
- [UI Documentation](./docs/HTML.md) - HTML structure and components

## 🐛 Troubleshooting

### Audio Issues
- **No microphone access**: Check browser permissions
- **System audio not working**: Use Chrome or Edge browser
- **Audio choppy**: Lower quality setting or check network

### Connection Issues
- **Can't find devices**: Ensure all devices are on same network
- **Connection failed**: Check firewall settings
- **Port already in use**: Change PORT environment variable

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Test thoroughly
5. Submit a pull request

## 📄 License

ISC License - see LICENSE file for details

## 🙏 Acknowledgments

- Bootstrap for the UI framework
- Socket.IO for real-time communication
- Web Audio API for audio processing
- Node.js community for excellent packages

   cd audio-transfer-app      // Remove tseslint.configs.recommended and replace with this

   ```      tseslint.configs.recommendedTypeChecked,

      // Alternatively, use this for stricter rules

2. **Install dependencies**      tseslint.configs.strictTypeChecked,

   ```bash      // Optionally, add this for stylistic rules

   npm install      tseslint.configs.stylisticTypeChecked,

   ```

      // Other configs...

3. **Start the server**    ],

   ```bash    languageOptions: {

   npm start      parserOptions: {

   ```        project: ['./tsconfig.node.json', './tsconfig.app.json'],

        tsconfigRootDir: import.meta.dirname,

4. **Open in browser**      },

   - Local: http://localhost:3001      // other options...

   - Network: http://[your-ip]:3001    },

  },

## 🎯 Usage])

```

### Streaming Audio

1. Go to the **Stream** tabYou can also install [eslint-plugin-react-x](https://github.com/Rel1cx/eslint-react/tree/main/packages/plugins/eslint-plugin-react-x) and [eslint-plugin-react-dom](https://github.com/Rel1cx/eslint-react/tree/main/packages/plugins/eslint-plugin-react-dom) for React-specific lint rules:

2. Select your audio source (Microphone, System Audio, or File)

3. Choose quality settings```js

4. Click **Start Streaming**// eslint.config.js

import reactX from 'eslint-plugin-react-x'

### Playing Audioimport reactDom from 'eslint-plugin-react-dom'

1. Go to the **Play** tab

2. The app will automatically discover streaming devicesexport default defineConfig([

3. Click **Connect** on any available device  globalIgnores(['dist']),

4. Control volume and enjoy the audio  {

    files: ['**/*.{ts,tsx}'],

## 🖥️ Desktop App (Coming Soon)    extends: [

      // Other configs...

This app can be packaged as a desktop application using:      // Enable lint rules for React

- **Electron** for Windows, macOS, Linux      reactX.configs['recommended-typescript'],

- **Tauri** for lightweight native apps      // Enable lint rules for React DOM

      reactDom.configs.recommended,

## 📱 Mobile App (Coming Soon)    ],

    languageOptions: {

Mobile versions can be created using:      parserOptions: {

- **Capacitor** for iOS/Android        project: ['./tsconfig.node.json', './tsconfig.app.json'],

- **React Native** adaptation        tsconfigRootDir: import.meta.dirname,

- **PWA** for web-based mobile experience      },

      // other options...

## 🚀 Building for Production    },

  },

### Desktop (Electron)])

```bash```

npm install -g electron
npm install electron --save-dev
# Create electron main.js and package
```

### Mobile (Capacitor)
```bash
npm install -g @capacitor/cli
npx cap init
npx cap add android
npx cap add ios
```

## 📁 Project Structure

```
audio-transfer-app/
├── index.html          # Main HTML file
├── app.js             # Frontend JavaScript
├── server.js          # Node.js backend
├── styles.css         # Custom styling
├── package.json       # Dependencies
└── README.md          # This file
```

## 🔧 Configuration

The server runs on port 3001 by default. To change:
```bash
PORT=3002 npm start
```

## 🌐 Network Access

To access from other devices on your network:
1. Make sure port 3001 is open in firewall
2. Use the network IP shown in server startup
3. Connect devices to the same WiFi network

## 🐛 Troubleshooting

### Mobile Streaming Issues (Can't stream from phone)
**HTTPS Required for Mobile**: Mobile browsers require HTTPS for microphone access on remote connections.

**Quick Fix Options:**
1. **Use ngrok (Recommended)**:
   ```bash
   # Install ngrok globally
   npm install -g ngrok
   
   # Start your server
   npm start
   
   # In another terminal, create HTTPS tunnel
   ngrok http 3001
   
   # Use the https:// URL on your mobile device
   ```

2. **Local IP Exception**: Some mobile browsers allow `http://` for local IPs:
   - Find your computer's IP: `ipconfig` (Windows) or `ifconfig` (Mac/Linux)
   - Try `http://192.168.1.XXX:3001` on mobile
   - If it doesn't work, use ngrok

3. **Network Requirements**:
   - Both devices must be on the same Wi-Fi network
   - Disable mobile data to ensure Wi-Fi usage
   - Check that firewall allows port 3001

### Audio not working
- Check browser permissions for microphone
- Ensure HTTPS for system audio capture
- Try different audio sources

### Connection issues
- Check firewall settings
- Verify devices are on same network
- Try manual IP connection

### Browser compatibility
- Chrome/Chromium: Full support
- Firefox: Limited system audio support  
- Safari: Basic functionality
- **Mobile Chrome/Safari**: Requires HTTPS for audio capture

## 🤝 Contributing

1. Fork the repository
2. Create feature branch
3. Make changes
4. Test thoroughly
5. Submit pull request

## 📄 License

MIT License - feel free to use and modify

## 🎉 Next Steps

Ready to create desktop and mobile versions? Here's what we can do:

1. **Windows Desktop App** using Electron
2. **Android APK** using Capacitor
3. **iOS App** using Capacitor
4. **Progressive Web App** for mobile browsers

Let me know which platform you'd like to tackle first!