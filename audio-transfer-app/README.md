# Audio Transfer App# React + TypeScript + Vite



A simple and elegant audio streaming application built with **JavaScript + Bootstrap + Node.js**. Stream audio across your local network with a clean, responsive interface.This template provides a minimal setup to get React working in Vite with HMR and some ESLint rules.



## 🚀 FeaturesCurrently, two official plugins are available:



- **Real-time Audio Streaming** - Stream from microphone, system audio, or files- [@vitejs/plugin-react](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react) uses [Babel](https://babeljs.io/) (or [oxc](https://oxc.rs) when used in [rolldown-vite](https://vite.dev/guide/rolldown)) for Fast Refresh

- **Device Discovery** - Automatically find devices on your network- [@vitejs/plugin-react-swc](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react-swc) uses [SWC](https://swc.rs/) for Fast Refresh

- **Multiple Quality Settings** - From 64kbps to 320kbps

- **Responsive Design** - Works on desktop, tablet, and mobile## React Compiler

- **Bootstrap UI** - Clean, modern interface with dark theme

- **Socket.IO Backend** - Real-time communicationThe React Compiler is not enabled on this template because of its impact on dev & build performances. To add it, see [this documentation](https://react.dev/learn/react-compiler/installation).



## 🛠️ Technology Stack## Expanding the ESLint configuration



- **Frontend**: HTML5, CSS3, JavaScript ES6+, Bootstrap 5If you are developing a production application, we recommend updating the configuration to enable type-aware lint rules:

- **Backend**: Node.js, Express, Socket.IO

- **Audio**: Web Audio API, WebRTC```js

- **Styling**: Bootstrap 5 + Custom CSSexport default defineConfig([

  globalIgnores(['dist']),

## 📦 Installation  {

    files: ['**/*.{ts,tsx}'],

1. **Clone the repository**    extends: [

   ```bash      // Other configs...

   git clone <repository-url>

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