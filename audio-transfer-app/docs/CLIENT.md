# App.js Documentation

## Overview

The `app.js` file contains the **AudioTransferApp** class, which manages the client-side functionality of the audio streaming application. It handles audio capture, playback, Socket.IO communication, device discovery, and the complete user interface interactions.

## Class: AudioTransferApp

### Constructor

```javascript
constructor() {
    this.socket = null;
    this.mediaStream = null;
    this.audioContext = null;
    this.isStreaming = false;
    this.isListening = false;
    this.audioQueue = [];
    this.playbackGainNode = null;
    this.connectedDevices = [];
    this.currentConnection = null;
    this.listeningToSource = null;
    
    this.init();
}
```

**Properties Overview**:

- **socket**: Socket.IO client connection instance
- **mediaStream**: MediaStream object for audio capture
- **audioContext**: Web Audio API context for audio processing
- **isStreaming**: Boolean flag for streaming state
- **isListening**: Boolean flag for listening state
- **audioQueue**: Array buffer for incoming audio data
- **playbackGainNode**: Web Audio API gain node for volume control
- **connectedDevices**: Array of discovered devices
- **currentConnection**: Currently connected device info
- **listeningToSource**: ID of the device being listened to

---

## Initialization Flow

### init()

```javascript
async init() {
    // Initialize Socket.IO connection
    this.initSocket();
    
    // Setup event listeners
    this.setupEventListeners();
    
    // Detect local IP
    await this.detectLocalIP();
    
    // Initialize device discovery
    this.discoverDevices();
    
    console.log('Audio Transfer App initialized');
}
```

**Initialization Sequence**:
1. **Socket Connection**: Establishes WebSocket connection to server
2. **Event Listeners**: Binds UI event handlers
3. **IP Detection**: Detects and displays local network address
4. **Device Discovery**: Requests initial device list from server

---

## Socket.IO Communication

### initSocket()

**Purpose**: Establishes and configures Socket.IO connection with event handlers.

#### Core Connection Events

1. **Connection Established**
   ```javascript
   this.socket.on('connect', () => {
       console.log('Connected to server');
       this.showToast('Connected to server', 'success');
   });
   ```

2. **Connection Lost**
   ```javascript
   this.socket.on('disconnect', () => {
       console.log('Disconnected from server');
       this.showToast('Disconnected from server', 'warning');
   });
   ```

#### Device Management Events

3. **Device List Updates**
   ```javascript
   this.socket.on('deviceList', (devices) => {
       this.updateDeviceList(devices);
   });
   ```
   - **Purpose**: Receives and displays updated list of available devices
   - **Trigger**: Called when any device connects/disconnects or changes state

4. **Client Connection Notifications**
   ```javascript
   this.socket.on('clientConnected', (clientInfo) => {
       this.connectedDevices.push(clientInfo);
       this.updateConnectedCount();
       this.showToast(`${clientInfo.name} connected`, 'success');
   });
   ```

5. **Client Disconnection Notifications**
   ```javascript
   this.socket.on('clientDisconnected', (clientInfo) => {
       this.connectedDevices = this.connectedDevices.filter(d => d.id !== clientInfo.id);
       this.updateConnectedCount();
       this.showToast(`${clientInfo.name} disconnected`, 'info');
   });
   ```

#### Audio Streaming Events

6. **Incoming Audio Stream**
   ```javascript
   this.socket.on('audioStream', (streamData) => {
       if (this.isListening && this.listeningToSource === streamData.sourceId) {
           this.playAudioData(streamData);
       }
   });
   ```
   - **Purpose**: Receives real-time audio data from streaming devices
   - **Filtering**: Only processes audio from the device currently being listened to

7. **Stream Status Events**
   ```javascript
   this.socket.on('streamStarted', (streamInfo) => {
       this.showToast(`${streamInfo.clientName} started streaming`, 'success');
       this.discoverDevices(); // Refresh device list
   });

   this.socket.on('streamStopped', (streamInfo) => {
       this.showToast(`${streamInfo.clientName} stopped streaming`, 'info');
       if (this.listeningToSource === streamInfo.clientId) {
           this.stopListening();
       }
       this.discoverDevices(); // Refresh device list
   });
   ```

#### Listener Management Events

8. **Listener Notifications**
   ```javascript
   this.socket.on('listenerJoined', (listenerInfo) => {
       this.showToast(`${listenerInfo.listenerName} started listening`, 'info');
       this.updateConnectedCount();
   });

   this.socket.on('joinedAsListener', (joinInfo) => {
       this.isListening = true;
       this.listeningToSource = joinInfo.sourceId;
       this.updateListeningUI(joinInfo.sourceName);
       this.showToast(`Now listening to ${joinInfo.sourceName}`, 'success');
   });
   ```

---

## User Interface Event Handlers

### setupEventListeners()

**Purpose**: Binds all UI events to their respective handler functions.

#### Stream Control Events

1. **Start/Stop Streaming Buttons**
   ```javascript
   document.getElementById('startStreamBtn').addEventListener('click', () => this.startStreaming());
   document.getElementById('stopStreamBtn').addEventListener('click', () => this.stopStreaming());
   ```

2. **Device Discovery**
   ```javascript
   document.getElementById('refreshDevices').addEventListener('click', () => this.discoverDevices());
   ```

3. **Manual Connection**
   ```javascript
   document.getElementById('manualConnect').addEventListener('click', () => this.manualConnect());
   ```

4. **Device Search Filter**
   ```javascript
   document.getElementById('deviceSearch').addEventListener('input', (e) => this.filterDevices(e.target.value));
   ```

#### Audio Configuration Events

5. **Audio Source Selection**
   ```javascript
   document.querySelectorAll('input[name="audioSource"]').forEach(input => {
       input.addEventListener('change', (e) => this.onAudioSourceChange(e.target.value));
   });
   ```

6. **Quality Selection**
   ```javascript
   document.querySelectorAll('input[name="quality"]').forEach(input => {
       input.addEventListener('change', (e) => this.onQualityChange(e.target.value));
   });
   ```

---

## Audio Streaming Functions

### startStreaming()

```javascript
async startStreaming() {
    try {
        const audioSource = document.querySelector('input[name="audioSource"]:checked').value;
        const quality = document.querySelector('input[name="quality"]:checked').value;
        
        // Get media stream based on source
        this.mediaStream = await this.getMediaStream(audioSource, quality);
        
        // Setup audio processing
        this.setupAudioProcessing();
        
        // Notify server
        this.socket.emit('startStreaming', {
            source: audioSource,
            quality: quality,
            deviceName: await this.getDeviceName()
        });
        
        // Update UI
        this.updateStreamingUI(true);
        
    } catch (error) {
        this.handleStreamingError(error);
    }
}
```

**Flow Breakdown**:
1. **Configuration Extraction**: Gets audio source and quality from UI
2. **Media Stream Acquisition**: Requests microphone/system audio access
3. **Audio Processing Setup**: Initializes Web Audio API processing chain
4. **Server Notification**: Informs server about streaming start
5. **UI Update**: Changes interface to reflect streaming state

#### Audio Source Handling

### getMediaStream(source, quality)

```javascript
async getMediaStream(source, quality) {
    const qualitySettings = {
        low: { bitrate: 64000, sampleRate: 22050 },
        medium: { bitrate: 128000, sampleRate: 44100 },
        high: { bitrate: 256000, sampleRate: 44100 },
        ultra: { bitrate: 320000, sampleRate: 48000 }
    };
    
    const settings = qualitySettings[quality];
    
    switch (source) {
        case 'microphone':
            return await navigator.mediaDevices.getUserMedia({
                audio: {
                    sampleRate: settings.sampleRate,
                    channelCount: 2,
                    echoCancellation: true,
                    noiseSuppression: true
                }
            });
            
        case 'system':
            return await navigator.mediaDevices.getDisplayMedia({
                audio: {
                    sampleRate: settings.sampleRate,
                    channelCount: 2
                },
                video: false
            });
    }
}
```

**Audio Source Types**:

1. **Microphone Audio**
   - Uses `getUserMedia()` API
   - Includes echo cancellation and noise suppression
   - Stereo audio capture (2 channels)

2. **System Audio**
   - Uses `getDisplayMedia()` API (with audio only)
   - Captures computer's audio output
   - Limited browser support (Chrome/Edge primarily)

3. **Quality Settings**
   - **Low**: 64kbps, 22.05kHz - Optimized for limited bandwidth
   - **Medium**: 128kbps, 44.1kHz - Standard quality
   - **High**: 256kbps, 44.1kHz - High quality
   - **Ultra**: 320kbps, 48kHz - Maximum quality

#### Audio Processing Pipeline

### setupAudioProcessing()

```javascript
setupAudioProcessing() {
    if (!this.mediaStream) return;
    
    this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
    const source = this.audioContext.createMediaStreamSource(this.mediaStream);
    
    // Add audio processing here (volume control, effects, etc.)
    const gainNode = this.audioContext.createGain();
    source.connect(gainNode);
    gainNode.connect(this.audioContext.destination);
    
    // Stream audio data to server via Socket.IO
    this.streamAudioData(source);
}
```

**Web Audio API Processing Chain**:
1. **AudioContext**: Main audio processing context
2. **MediaStreamSource**: Converts MediaStream to audio node
3. **GainNode**: Controls volume and applies effects
4. **Destination**: Routes to speakers/output
5. **ScriptProcessor**: Extracts audio data for transmission

### streamAudioData(source)

```javascript
streamAudioData(source) {
    const processor = this.audioContext.createScriptProcessor(4096, 2, 2);
    
    processor.onaudioprocess = (e) => {
        if (!this.isStreaming) return;
        
        const inputBuffer = e.inputBuffer;
        
        // Process audio data
        for (let channel = 0; channel < inputBuffer.numberOfChannels; channel++) {
            const inputData = inputBuffer.getChannelData(channel);
            
            // Send audio data to server
            this.socket.emit('audioData', {
                channel: channel,
                data: Array.from(inputData)
            });
        }
    };
    
    source.connect(processor);
    processor.connect(this.audioContext.destination);
}
```

**Audio Data Transmission**:
- **Buffer Size**: 4096 samples for balance of latency vs. efficiency
- **Channel Processing**: Handles stereo audio (2 channels)
- **Data Format**: Converts Float32Array to regular Array for JSON transmission
- **Real-time**: Sends audio data as it's captured

---

## Audio Playback Functions

### Audio Listening Flow

### startListening(sourceId)

```javascript
startListening(sourceId) {
    if (!this.audioContext) {
        this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
    }
    
    this.setupAudioPlayback();
    this.socket.emit('joinAsListener', sourceId);
    this.showToast('Connecting to audio stream...', 'info');
}
```

**Purpose**: Initiates listening to a specific audio source.

**Flow**:
1. **Audio Context**: Creates Web Audio API context if needed
2. **Playback Setup**: Initializes audio playback pipeline
3. **Server Notification**: Registers as listener for specific source
4. **UI Feedback**: Shows connection status

### setupAudioPlayback()

```javascript
setupAudioPlayback() {
    if (!this.audioContext) return;
    
    // Create gain node for volume control
    this.playbackGainNode = this.audioContext.createGain();
    this.playbackGainNode.connect(this.audioContext.destination);
}
```

**Audio Playback Pipeline**:
- **GainNode**: Controls playback volume
- **Destination**: Routes to speakers/headphones

### playAudioData(streamData)

```javascript
playAudioData(streamData) {
    if (!this.audioContext || !this.playbackGainNode || !streamData.data) return;
    
    try {
        // Create buffer for audio data
        const buffer = this.audioContext.createBuffer(
            1, // mono for now
            streamData.data.length,
            this.audioContext.sampleRate
        );
        
        // Fill buffer with audio data
        const channelData = buffer.getChannelData(0);
        for (let i = 0; i < streamData.data.length; i++) {
            channelData[i] = streamData.data[i];
        }
        
        // Create and start buffer source
        const source = this.audioContext.createBufferSource();
        source.buffer = buffer;
        source.connect(this.playbackGainNode);
        source.start();
        
    } catch (error) {
        console.error('Error playing audio data:', error);
    }
}
```

**Playback Process**:
1. **Buffer Creation**: Creates AudioBuffer with received data
2. **Data Population**: Fills buffer with audio samples
3. **Source Creation**: Creates BufferSource for playback
4. **Connection**: Links to gain node and destination
5. **Playback**: Starts immediate audio playback

### stopListening()

```javascript
stopListening() {
    if (this.isListening) {
        this.isListening = false;
        this.listeningToSource = null;
        this.socket.emit('leaveAsListener');
        
        // Update UI
        const listenStatus = document.getElementById('listenStatus');
        if (listenStatus) {
            listenStatus.classList.add('d-none');
        }
        
        this.showToast('Stopped listening', 'info');
    }
}
```

---

## Device Discovery and Management

### discoverDevices()

```javascript
discoverDevices() {
    const refreshBtn = document.getElementById('refreshDevices');
    const originalText = refreshBtn.innerHTML;
    
    refreshBtn.disabled = true;
    refreshBtn.innerHTML = '<span class="spinner-border spinner-border-sm me-2"></span>Scanning...';
    
    // Request device list from server
    this.socket.emit('discoverDevices');
    
    // Simulate scan time
    setTimeout(() => {
        refreshBtn.disabled = false;
        refreshBtn.innerHTML = originalText;
    }, 2000);
}
```

**Discovery Process**:
1. **UI Feedback**: Shows scanning animation
2. **Server Request**: Requests current device list
3. **Response Handling**: Updates device list when received
4. **UI Reset**: Restores button after scan timeout

### updateDeviceList(devices)

```javascript
updateDeviceList(devices) {
    const deviceList = document.getElementById('deviceList');
    const onlineCount = devices.filter(d => d.status === 'online').length;
    
    document.getElementById('onlineDeviceCount').textContent = `${onlineCount} online`;
    
    if (devices.length === 0) {
        deviceList.innerHTML = `
            <div class="text-center py-5">
                <i class="bi bi-search text-muted" style="font-size: 3rem;"></i>
                <p class="text-muted mt-3">No devices found</p>
            </div>
        `;
        return;
    }
    
    deviceList.innerHTML = devices.map(device => this.renderDeviceCard(device)).join('');
}
```

**Device List Features**:
- **Online Count**: Displays number of available devices
- **Empty State**: Shows helpful message when no devices found
- **Device Cards**: Renders each device with connection options

#### Device Card Rendering

### renderDeviceCard(device)

```javascript
// Enhanced device card with streaming status
`<div class="card device-card bg-dark border-secondary mb-3 ${device.status === 'offline' ? 'offline' : ''} ${this.listeningToSource === device.id ? 'listening' : ''}">
    <div class="card-body">
        <div class="d-flex justify-content-between align-items-center">
            <div class="d-flex align-items-center">
                <div class="bg-${device.status === 'online' ? (device.isStreaming ? 'success' : 'primary') : 'secondary'} rounded-3 p-2 me-3">
                    <i class="bi bi-${this.getDeviceIcon(device.type)} text-white"></i>
                </div>
                <div>
                    <h6 class="mb-1">
                        ${device.name}
                        ${device.isStreaming ? '<i class="bi bi-broadcast text-success ms-2" title="Streaming"></i>' : ''}
                    </h6>
                    <small class="text-muted font-monospace">${device.ip}:${device.port}</small>
                    ${device.isStreaming ? '<br><small class="badge bg-success">🔴 LIVE</small>' : ''}
                </div>
            </div>
            <div class="text-end">
                ${this.renderConnectionButton(device)}
            </div>
        </div>
    </div>
</div>`
```

**Visual Elements**:
- **Status Indicators**: Color-coded icons and badges
- **Streaming Status**: Live indicator for active streams
- **Device Icons**: Type-specific icons (desktop, mobile, tablet)
- **Connection Buttons**: Context-aware action buttons

### getDeviceIcon(type)

```javascript
getDeviceIcon(type) {
    switch (type) {
        case 'desktop': return 'pc-display';
        case 'mobile': return 'phone';
        case 'tablet': return 'tablet';
        default: return 'speaker';
    }
}
```

---

## Network and Connection Management

### detectLocalIP()

```javascript
async detectLocalIP() {
    try {
        // Create a dummy peer connection to get local IP
        const pc = new RTCPeerConnection({
            iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
        });
        
        pc.createDataChannel('');
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        
        const localIP = await new Promise((resolve) => {
            pc.onicecandidate = (e) => {
                if (e.candidate) {
                    const candidate = e.candidate.candidate;
                    const ipMatch = candidate.match(/(\d+\.\d+\.\d+\.\d+)/);
                    if (ipMatch) {
                        resolve(ipMatch[1]);
                        pc.close();
                    }
                }
            };
        });
        
        document.getElementById('localIP').textContent = `${localIP}:3001`;
    } catch (error) {
        console.error('Failed to detect local IP:', error);
        document.getElementById('localIP').textContent = 'localhost:3001';
    }
}
```

**IP Detection Method**:
- **WebRTC**: Uses RTCPeerConnection to discover local network IP
- **STUN Server**: Google's public STUN server for NAT traversal
- **ICE Candidates**: Extracts IP from connection candidates
- **Fallback**: Uses localhost if detection fails

### connectToDevice(deviceId)

```javascript
connectToDevice(deviceId) {
    const device = this.connectedDevices.find(d => d.id === deviceId);
    if (!device) {
        this.showToast('Device not found', 'error');
        return;
    }

    if (device.isStreaming) {
        // Connect as listener to streaming device
        this.startListening(deviceId);
    } else {
        this.showToast('Device is not currently streaming', 'warning');
    }
}
```

### manualConnect()

```javascript
manualConnect() {
    const manualIP = document.getElementById('manualIP').value.trim();
    if (!manualIP) {
        this.showToast('Please enter an IP address', 'error');
        return;
    }
    
    const [ip, port = '3001'] = manualIP.split(':');
    
    this.showToast('Connecting...', 'info');
    this.socket.emit('manualConnect', { ip, port: parseInt(port) });
}
```

---

## User Interface Management

### updateListeningUI(sourceName)

```javascript
updateListeningUI(sourceName) {
    // Add listening status indicator
    let listenStatus = document.getElementById('listenStatus');
    if (!listenStatus) {
        const statusHTML = `
            <div class="alert alert-info mt-4" id="listenStatus">
                <div class="d-flex align-items-center justify-content-between">
                    <div class="d-flex align-items-center">
                        <div class="spinner-grow spinner-grow-sm text-info me-2" role="status"></div>
                        <strong>LISTENING TO: <span id="listenSourceName">${sourceName}</span></strong>
                    </div>
                    <button class="btn btn-sm btn-outline-info" onclick="app.stopListening()">
                        <i class="bi bi-stop-fill me-1"></i>Stop Listening
                    </button>
                </div>
            </div>
        `;
        
        document.querySelector('#play .card-body').insertAdjacentHTML('beforeend', statusHTML);
    } else {
        document.getElementById('listenSourceName').textContent = sourceName;
        listenStatus.classList.remove('d-none');
    }
}
```

### filterDevices(query)

```javascript
filterDevices(query) {
    const deviceCards = document.querySelectorAll('.device-card');
    deviceCards.forEach(card => {
        const deviceName = card.querySelector('h6').textContent.toLowerCase();
        const deviceIP = card.querySelector('.font-monospace').textContent.toLowerCase();
        
        if (deviceName.includes(query.toLowerCase()) || deviceIP.includes(query.toLowerCase())) {
            card.style.display = 'block';
        } else {
            card.style.display = 'none';
        }
    });
}
```

**Search Features**:
- **Device Name Filtering**: Searches device names
- **IP Address Filtering**: Searches IP addresses
- **Real-time**: Updates as user types
- **Case Insensitive**: Ignores case differences

---

## Utility Functions

### showToast(message, type)

```javascript
showToast(message, type = 'info') {
    const toastContainer = document.getElementById('toastContainer');
    const toastId = 'toast-' + Date.now();
    
    const bgClass = {
        'success': 'bg-success',
        'error': 'bg-danger',
        'warning': 'bg-warning',
        'info': 'bg-info'
    }[type] || 'bg-info';
    
    const icon = {
        'success': 'check-circle',
        'error': 'x-circle',
        'warning': 'exclamation-triangle',
        'info': 'info-circle'
    }[type] || 'info-circle';
    
    // Create and show toast
    const toastHTML = `
        <div class="toast align-items-center ${bgClass} border-0" id="${toastId}">
            <div class="d-flex">
                <div class="toast-body text-white">
                    <i class="bi bi-${icon} me-2"></i>${message}
                </div>
                <button type="button" class="btn-close btn-close-white me-2 m-auto" data-bs-dismiss="toast"></button>
            </div>
        </div>
    `;
    
    toastContainer.insertAdjacentHTML('beforeend', toastHTML);
    
    const toastElement = document.getElementById(toastId);
    const toast = new bootstrap.Toast(toastElement);
    toast.show();
    
    // Auto-remove after hiding
    toastElement.addEventListener('hidden.bs.toast', () => {
        toastElement.remove();
    });
}
```

**Toast Notification System**:
- **Types**: success, error, warning, info
- **Auto-removal**: Cleans up DOM after hiding
- **Unique IDs**: Prevents conflicts with timestamp-based IDs
- **Bootstrap Integration**: Uses Bootstrap toast component

### getDeviceName()

```javascript
async getDeviceName() {
    try {
        const userAgent = navigator.userAgent;
        if (userAgent.includes('Windows')) return 'Windows PC';
        if (userAgent.includes('Mac')) return 'Mac';
        if (userAgent.includes('Linux')) return 'Linux PC';
        if (userAgent.includes('Android')) return 'Android Device';
        if (userAgent.includes('iPhone') || userAgent.includes('iPad')) return 'iOS Device';
        return 'Unknown Device';
    } catch {
        return 'My Device';
    }
}
```

### updateConnectedCount()

```javascript
updateConnectedCount() {
    document.getElementById('connectedCount').textContent = this.connectedDevices.length;
}
```

---

## Error Handling

### Stream Error Handling

```javascript
handleStreamingError(error) {
    console.error('Failed to start streaming:', error);
    this.showToast('Failed to start streaming: ' + error.message, 'error');
    
    // Reset UI
    const startBtn = document.getElementById('startStreamBtn');
    startBtn.disabled = false;
    startBtn.innerHTML = '<i class="bi bi-play-fill me-2"></i>Start Streaming';
}
```

**Common Error Scenarios**:
- **Microphone Permission Denied**: User denies audio access
- **System Audio Not Supported**: Browser doesn't support display media
- **Audio Context Issues**: Web Audio API initialization problems
- **Network Connectivity**: Socket.IO connection failures

---

## Application Lifecycle

### DOMContentLoaded Event

```javascript
document.addEventListener('DOMContentLoaded', () => {
    window.app = new AudioTransferApp();
});
```

**Initialization Order**:
1. **DOM Ready**: Waits for HTML to load completely
2. **App Creation**: Instantiates AudioTransferApp
3. **Socket Connection**: Establishes server connection
4. **UI Binding**: Sets up event listeners
5. **Device Discovery**: Requests initial device list

### Module Export

```javascript
if (typeof module !== 'undefined' && module.exports) {
    module.exports = AudioTransferApp;
}
```

**Compatibility**: Supports both browser and potential Node.js usage

---

## Performance Considerations

1. **Audio Buffer Management**
   - 4096-sample buffers balance latency and performance
   - Real-time processing without significant delay
   - Automatic cleanup of audio nodes

2. **Memory Efficiency**
   - Arrays are converted from Float32Array only for transmission
   - Audio buffers are short-lived and garbage collected
   - Device lists are efficiently filtered without recreation

3. **Network Optimization**
   - Audio data sent in real-time chunks
   - Minimal metadata overhead
   - Efficient Socket.IO event handling

4. **UI Responsiveness**
   - Async/await for smooth user interactions
   - Loading states for long operations
   - Toast notifications for immediate feedback

---

## Browser Compatibility

**Required APIs**:
- **Web Audio API**: Chrome 34+, Firefox 25+, Safari 6+
- **getUserMedia**: Chrome 53+, Firefox 36+, Safari 11+
- **getDisplayMedia**: Chrome 72+, Firefox 66+, Safari 13+
- **Socket.IO**: All modern browsers
- **WebRTC**: Chrome 23+, Firefox 22+, Safari 11+

**Fallback Strategies**:
- IP detection falls back to localhost
- Audio source detection with user agent parsing
- Graceful degradation for unsupported features

---

This client-side application provides a comprehensive audio streaming solution with device discovery, real-time communication, and cross-platform compatibility.