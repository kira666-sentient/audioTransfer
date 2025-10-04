# Client-Side Documentation (app.js)

This document explains the structure and functionality of the `app.js` file, which manages the client-side logic for the Audio Transfer application.

## `AudioTransferApp` Class

The core of the client-side application is the `AudioTransferApp` class.

### `constructor()`

```javascript
class AudioTransferApp {
  constructor() {
    // socket + stream
    this.socket = null;
    this.mediaStream = null;

    // capture
    this.captureContext = null;
    this.captureSourceNode = null;
    this.workletNode = null;
    this.processorNode = null;
    this.silentGainNode = null;
    this._sendSeq = 0;

    // playback
    this.audioContext = null;
    this.playbackGain = null;
    this.audioQueue = [];
    this.isProcessingQueue = false;
    this.nextPlayTime = 0;
    this.fixedLatency = 0.12; // seconds - low and stable
    this.activeSources = new Set();

    // playback controls
    this.volumeControl = null;
    this.eqNodes = {};
    this.compressorNode = null;
    this.limiterNode = null;
    this.playbackMode = 'low';
    this.eqPreset = 'flat';

    // state
    this.isStreaming = false;
    this.isListening = false;
    this.listeningToSource = null;
    this.packetCount = 0;

    document.addEventListener('DOMContentLoaded', () => this.init());
  }
```
**Explanation**:
The constructor initializes all properties for the application. It sets up variables for WebSocket communication (`socket`), audio capture (`mediaStream`, `captureContext`), audio playback (`audioContext`, `audioQueue`), and UI controls. It also sets initial state flags and adds an event listener to start the application once the page is loaded.

### `init()`

```javascript
  init() {
    this.initSocket();
    this.setupEventListeners();
    this.detectLocalIP();
  }
```
**Explanation**:
This function is the main entry point for the application. It initializes the WebSocket connection, sets up all the UI event listeners, and attempts to detect the user's local IP address.

### `initSocket()`

```javascript
  initSocket() {
    if (this.socket) return;
    
    // Check for mobile HTTPS requirement
    const isMobile = /Android|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
    if (isMobile && location.protocol !== 'https:' && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1') {
      this.showToast('Mobile devices require HTTPS for audio features. Please use https:// in the URL.', 'error');
    }

    this.socket = io({
      transports: ['websocket', 'polling'],
      upgrade: true,
      rememberUpgrade: true,
      timeout: 20000,
      forceNew: false
    });

    this.socket.on('connect', () => {
      console.log('Connected to server');
      const s = document.getElementById('serverStatus');
      if (s && !this.isStreaming && !this.isListening) { s.textContent = 'ONLINE'; s.className = 'badge bg-success'; }
      this.socket.emit('discoverDevices');
    });
    // ... other socket event handlers
```
**Explanation**:
This function sets up the Socket.IO connection to the server. It includes a check for mobile devices to enforce the use of HTTPS, which is required for audio capture. It also defines event handlers for connection, disconnection, errors, and custom application events like receiving a device list.

### `getMediaStream(source, quality)`

```javascript
  async getMediaStream(source, quality) {
    const q = {
      low: { sampleRate: 22050, channelCount: 1 },
      medium: { sampleRate: 44100, channelCount: 1 },
      high: { sampleRate: 44100, channelCount: 2 },
      ultra: { sampleRate: 48000, channelCount: 2 }
    };
    const settings = q[quality] || q.high;
    if (source === 'microphone') {
      // ... requests microphone
    }
    if (source === 'system') {
      // ... requests system audio
    }
    if (source === 'file') {
      // ... handles file selection
    }
    throw new Error('Unknown source');
  }
```
**Explanation**:
This function is responsible for acquiring the audio source. It can capture audio from the user's microphone, the entire computer's system audio, or a selected audio file. It uses different quality presets to control the sample rate and channel count.

### `startStreaming()`

```javascript
  async startStreaming() {
    try {
      // ... UI updates and checks
      this.mediaStream = await this.getMediaStream(source, quality);

      this.captureContext = new (window.AudioContext || window.webkitAudioContext)();
      this.captureSourceNode = this.captureContext.createMediaStreamSource(this.mediaStream);

      // prefer AudioWorklet
      try {
        // ... sets up AudioWorklet for processing
      } catch (err) {
        // ... fallback to ScriptProcessor
      }

      this.socket.emit('startStreaming', { source, quality, deviceName: name });
      // ... more UI updates
    } catch (e) {
      // ... error handling
    }
  }
```
**Explanation**:
This function orchestrates the process of starting an audio stream. It gets the media stream, sets up the Web Audio API context for processing, and uses a modern `AudioWorklet` (or a fallback `ScriptProcessor`) to capture audio data in small chunks and send it to the server via WebSockets.

### `playAudioData(streamData)`

```javascript
  async playAudioData(streamData) {
    // ... normalizes incoming data
    const srcRate = streamData.sampleRate || 48000;
    const channels = streamData.channels || 1;

    // Resample using OfflineAudioContext for best quality
    if (srcRate !== targetRate) {
        processedInterleaved = await this.resampleInterleaved(interleaved, srcRate, targetRate, channels);
    }

    this.audioQueue.push({ data: processedInterleaved, channels: processedChannels, sampleRate: targetRate, timestamp: streamData.timestamp || Date.now() });

    if (!this.isProcessingQueue) this.processAudioQueue();
  }
```
**Explanation**:
This function handles incoming audio packets. It normalizes the data, resamples it to match the local audio context's sample rate for high-quality playback, and adds it to a queue. A separate processing loop (`processAudioQueue`) then schedules the audio to be played with a fixed latency to ensure smooth, continuous sound.

### `setupAudioPlayback()`

```javascript
  setupAudioPlayback() {
    if (!this.audioContext) return;
    
    // Create EQ nodes
    const eqBands = [60, 250, 1000, 4000, 12000];
    // ... creates BiquadFilter nodes for each band

    // Create main playback gain
    if (!this.playbackGain) {
      this.playbackGain = this.audioContext.createGain();
    }

    // Setup audio processing chain: EQ -> Compressor -> Gain -> Destination
    let currentNode = this.eqNodes[60];
    // ... connects all EQ nodes in series

    if (this.compressorNode) {
      currentNode.connect(this.compressorNode);
      this.compressorNode.connect(this.playbackGain);
    } else {
      currentNode.connect(this.playbackGain);
    }

    this.playbackGain.connect(this.audioContext.destination);
  }
```
**Explanation**:
This function constructs the audio processing graph for playback. It creates a 5-band equalizer, a dynamics compressor for loudness boost, and a main volume control. All incoming audio is passed through this chain before reaching the speakers, allowing for real-time audio effects.

### `updateDeviceList(devices)`

```javascript
  updateDeviceList(devices) {
    const listEl = document.getElementById('deviceList');
    // ... clears the list
    devices.forEach(d => {
      // ... creates a row for each device
      if (d.isStreaming) {
        // ... adds a "Listen" button
      } else {
        // ... adds a disabled "Not streaming" button
      }
      listEl.appendChild(row);
    });
    // ... updates online device count
  }
```
**Explanation**:
This function dynamically renders the list of available devices. It receives an array of device objects from the server and creates a UI element for each one. It shows a "Listen" button only for devices that are actively streaming audio.

---

## Application Flow Diagram

```
┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
│   User Opens    │    │  Socket.IO      │    │   Server        │
│   Browser       │───▶│  Connection     │───▶│   Discovery     │
└─────────────────┘    └─────────────────┘    └─────────────────┘
        │                      │                      │
        ▼                      ▼                      ▼
┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
│  Device List    │◀───│  Discover       │    │  Mobile HTTPS   │
│  Population     │    │  Devices        │    │  Check          │
└─────────────────┘    └─────────────────┘    └─────────────────┘

STREAMING FLOW (Sender):
┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
│ User Selects    │    │ getUserMedia/   │    │ AudioWorklet/   │
│ Source & Quality│───▶│ getDisplayMedia │───▶│ ScriptProcessor │
└─────────────────┘    └─────────────────┘    └─────────────────┘
        │                      │                      │
        ▼                      ▼                      ▼
┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
│   MediaStream   │    │   Audio         │    │   Packet        │
│   Created       │───▶│   Processing    │───▶│   Transmission  │
└─────────────────┘    └─────────────────┘    └─────────────────┘

LISTENING FLOW (Receiver):
┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
│ User Clicks     │    │ Socket Emits    │    │ Audio Context   │
│ Listen Button   │───▶│ joinAsListener  │───▶│ Initialization  │
└─────────────────┘    └─────────────────┘    └─────────────────┘
        │                      │                      │
        ▼                      ▼                      ▼
┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
│  Receive Audio  │    │   EQ & Volume   │    │   Speaker       │
│  Packets        │───▶│   Processing    │───▶│   Output        │
└─────────────────┘    └─────────────────┘    └─────────────────┘

AUDIO PROCESSING CHAIN:
Source → MediaStream → AudioWorklet → 20ms Packets → Socket.IO → Server
                                                                    │
                                                                    ▼
Speaker ← EQ Chain ← Volume ← Audio Buffer ← Resampling ← Socket.IO ← Listeners
```
**Explanation**:
This diagram illustrates the complete application flow. It shows the initialization sequence, the process for sending audio (streaming), and the process for receiving audio (listening). It also visualizes the Web Audio API processing chain for both capture and playback.