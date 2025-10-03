// app.js - Fixed and simplified Audio Transfer client

class AudioTransferApp {
    constructor() {
        // Socket + audio state
        this.socket = null;
        this.mediaStream = null;
        this.audioContext = null;
        this.sourceNode = null;
        this.processorNode = null; // ScriptProcessor fallback
        this.workletNode = null;
        this.isStreaming = false;
        this.isListening = false;
    // A muted gain to keep processing nodes pulled without feedback
    this.silentGainNode = null;

    // Playback state
        this.playbackGainNode = null;
        this.audioQueue = [];
        this.isProcessingQueue = false;
        this.nextPlayTime = 0;
        this.audioLatency = 0.1; // seconds
    // Packet counter for received audioStream events
    this.packetCount = 0;

        // Rate limiting
        this.lastAudioSent = 0;
        this.audioSendInterval = 20; // ms

        document.addEventListener('DOMContentLoaded', () => this.init());
    }

    async init() {
        this.initSocket();
        this.setupEventListeners();
        await this.detectLocalIP();
        console.log('AudioTransferApp initialized');
    }

    initSocket() {
        // expecting socket.io client already loaded on page <script src="/socket.io/socket.io.js"></script>
        this.socket = io();

        this.socket.on('connect', () => {
            console.log('Connected to server', this.socket.id);
            const serverStatus = document.getElementById('serverStatus');
            if (serverStatus && !this.isStreaming && !this.isListening) {
                serverStatus.textContent = 'ONLINE';
                serverStatus.className = 'badge bg-success';
            }
        });

        this.socket.on('disconnect', () => {
            console.log('Disconnected from server');
            const serverStatus = document.getElementById('serverStatus');
            if (serverStatus) {
                serverStatus.textContent = 'OFFLINE';
                serverStatus.className = 'badge bg-secondary';
            }
        });

        this.socket.on('deviceList', (devices) => this.updateDeviceList(devices));

        this.socket.on('streamStarted', (info) => {
            this.showToast(`${info.clientName || 'A device'} started streaming`, 'success');
            this.socket.emit('discoverDevices');
        });

        this.socket.on('streamStopped', (info) => {
            this.showToast(`${info.clientName || 'A device'} stopped streaming`, 'info');
            this.socket.emit('discoverDevices');
            if (this.listeningToSource === info.clientId) {
                this.stopListening();
            }
        });

        this.socket.on('audioStream', (streamData) => {
            // Count received audio packets
            this.packetCount++;
            const pcEl = document.getElementById('packetCount');
            if (pcEl) pcEl.textContent = this.packetCount;
            // Play if actively listening
            if (this.isListening && this.listeningToSource === streamData.sourceId) {
                this.playAudioData(streamData);
            }
        });

        this.socket.on('joinedAsListener', (info) => {
            this.isListening = true;
            this.listeningToSource = info.sourceId;
            this.updateListeningUI(info.sourceName || 'Unknown');
        });

        this.socket.on('rateLimitWarning', () => {
            this.showToast('Server adjusted streaming rate for you', 'warning');
        });

        // Update listener count UI for the current streamer
        this.socket.on('listenerCounts', (counts) => {
            if (this.isStreaming) {
                const count = counts[this.socket.id] || 0;
                const countEl = document.getElementById('connectedCount');
                if (countEl) countEl.textContent = count;
            }
        });
    }

    setupEventListeners() {
        const startBtn = document.getElementById('startStreamBtn');
        const stopBtn = document.getElementById('stopStreamBtn');
        const refreshBtn = document.getElementById('refreshDevices');
        const manualConnectBtn = document.getElementById('manualConnect');
        const deviceSearch = document.getElementById('deviceSearch');

        if (startBtn) startBtn.addEventListener('click', () => this.startStreaming());
        if (stopBtn) stopBtn.addEventListener('click', () => this.stopStreaming());
        if (refreshBtn) refreshBtn.addEventListener('click', () => this.discoverDevices());
        if (manualConnectBtn) manualConnectBtn.addEventListener('click', () => this.manualConnect());
        if (deviceSearch) deviceSearch.addEventListener('input', (e) => this.filterDevices(e.target.value));
    }

    async detectLocalIP() {
        // best-effort local IP detection using RTC
        try {
            const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
            pc.createDataChannel('');
            const offer = await pc.createOffer();
            await pc.setLocalDescription(offer);

            const localIP = await new Promise((resolve, reject) => {
                pc.onicecandidate = (e) => {
                    if (!e.candidate) return;
                    const cand = e.candidate.candidate;
                    const m = cand.match(/(\d+\.\d+\.\d+\.\d+)/);
                    if (m) {
                        resolve(m[1]);
                        pc.close();
                    }
                };
                setTimeout(() => reject(new Error('timeout')), 2000);
            });

            const el = document.getElementById('localIP');
            if (el) el.textContent = `${localIP}:3001`;
        } catch (err) {
            const el = document.getElementById('localIP');
            if (el) el.textContent = 'localhost:3001';
        }
    }

    async startStreaming() {
        try {
            const startBtn = document.getElementById('startStreamBtn');
            const stopBtn = document.getElementById('stopStreamBtn');
            const liveIndicator = document.getElementById('liveIndicator');
            const serverStatus = document.getElementById('serverStatus');

            if (startBtn) {
                startBtn.disabled = true;
                startBtn.innerHTML = 'Starting...';
            }

            const audioSource = (document.querySelector('input[name="audioSource"]:checked') || {}).value || 'microphone';
            const quality = (document.querySelector('input[name="quality"]:checked') || {}).value || 'high';

            this.mediaStream = await this.getMediaStream(audioSource, quality);
            await this.setupAudioProcessing();

            const deviceName = await this.getDeviceName();

            this.socket.emit('startStreaming', {
                source: audioSource,
                quality,
                deviceName
            });

            this.isStreaming = true;
            if (startBtn) startBtn.classList.add('d-none');
            if (stopBtn) stopBtn.classList.remove('d-none');
            if (liveIndicator) liveIndicator.classList.remove('d-none');
            if (serverStatus) {
                serverStatus.textContent = 'LIVE';
                serverStatus.className = 'badge bg-success';
            }

            this.showToast('Streaming started', 'success');
        } catch (err) {
            console.error('startStreaming error', err);
            this.showToast('Failed to start streaming: ' + (err.message || err), 'error');
            const startBtn = document.getElementById('startStreamBtn');
            if (startBtn) {
                startBtn.disabled = false;
                startBtn.innerHTML = '<i class="bi bi-play-fill me-2"></i>Start Streaming';
            }
        }
    }

    async stopStreaming() {
        try {
            // stop local capture
            if (this.mediaStream) {
                this.mediaStream.getTracks().forEach(t => t.stop());
                this.mediaStream = null;
            }

            // disconnect audio nodes
            if (this.sourceNode) { try { this.sourceNode.disconnect(); } catch (e) { } this.sourceNode = null; }
            if (this.workletNode) { try { this.workletNode.disconnect(); } catch (e) { } this.workletNode = null; }
            if (this.processorNode) { try { this.processorNode.disconnect(); } catch (e) { } this.processorNode = null; }
            if (this.silentGainNode) { try { this.silentGainNode.disconnect(); } catch (e) { } this.silentGainNode = null; }

            if (this.audioContext && this.audioContext.state !== 'closed') {
                await this.audioContext.close();
            }
            this.audioContext = null;
            this.isStreaming = false;

            this.socket.emit('stopStreaming');

            const startBtn = document.getElementById('startStreamBtn');
            const stopBtn = document.getElementById('stopStreamBtn');
            const liveIndicator = document.getElementById('liveIndicator');
            const serverStatus = document.getElementById('serverStatus');

            if (stopBtn) stopBtn.classList.add('d-none');
            if (startBtn) startBtn.classList.remove('d-none');
            if (liveIndicator) liveIndicator.classList.add('d-none');
            if (startBtn) {
                startBtn.disabled = false;
                startBtn.innerHTML = '<i class="bi bi-play-fill me-2"></i>Start Streaming';
            }

            if (!this.isListening && serverStatus) {
                serverStatus.textContent = 'OFFLINE';
                serverStatus.className = 'badge bg-secondary';
            } else if (serverStatus) {
                serverStatus.textContent = 'LISTENING';
                serverStatus.className = 'badge bg-info';
            }

            this.showToast('Stopped streaming', 'info');
        } catch (err) {
            console.error('stopStreaming error', err);
            this.showToast('Error stopping stream', 'error');
        }
    }

    async getMediaStream(source, quality) {
        const qualitySettings = {
            low: { sampleRate: 22050, channelCount: 1 },
            medium: { sampleRate: 44100, channelCount: 1 },
            high: { sampleRate: 44100, channelCount: 2 },
            ultra: { sampleRate: 48000, channelCount: 2 }
        };
        const settings = qualitySettings[quality] || qualitySettings.high;

        if (source === 'microphone') {
            return await navigator.mediaDevices.getUserMedia({
                audio: {
                    sampleRate: settings.sampleRate,
                    channelCount: settings.channelCount,
                    echoCancellation: true,
                    noiseSuppression: true,
                    autoGainControl: true
                }
            });
        }

        if (source === 'system') {
            try {
                // Some browsers require you to share the screen to get system audio
                const stream = await navigator.mediaDevices.getDisplayMedia({
                    audio: true,
                    video: true   // <- must request video as well on Chrome
                });

                if (!stream.getAudioTracks().length) {
                    stream.getTracks().forEach(t => t.stop());
                    throw new Error('System audio not available. Please include audio when selecting screen.');
                }

                // Stop the video track immediately — we only want audio
                stream.getVideoTracks().forEach(track => track.stop());
                return stream;
            } catch (err) {
                console.error('System audio capture failed:', err);
                throw new Error('System audio capture is not supported on this browser/device.');
            }
        }

        throw new Error('Unknown audio source: ' + source);
    }

    async setupAudioProcessing() {
        if (!this.mediaStream) return;
        // cleanup old
        if (this.audioContext && this.audioContext.state !== 'closed') {
            try { await this.audioContext.close(); } catch (e) { }
            this.audioContext = null;
        }

        this.audioContext = new (window.AudioContext || window.webkitAudioContext)();

        // create source
        this.sourceNode = this.audioContext.createMediaStreamSource(this.mediaStream);

        // prefer AudioWorklet if available
        if (this.audioContext.audioWorklet) {
            try {
                const blobUrl = this.createAudioWorkletScript();
                await this.audioContext.audioWorklet.addModule(blobUrl);
                this.workletNode = new AudioWorkletNode(this.audioContext, 'audio-processor');
                this.workletNode.port.onmessage = (e) => {
                    if (e.data && e.data.audioBuffer) {
                        this.sendAudioToServer(e.data.audioBuffer);
                    }
                };
                this.sourceNode.connect(this.workletNode);
                // Ensure the worklet is pulled by connecting to a muted gain -> destination
                if (!this.silentGainNode) {
                    this.silentGainNode = this.audioContext.createGain();
                    this.silentGainNode.gain.value = 0.0;
                    this.silentGainNode.connect(this.audioContext.destination);
                }
                this.workletNode.connect(this.silentGainNode);
                return;
            } catch (err) {
                console.warn('Worklet failed, falling back to ScriptProcessor', err);
            }
        }

        // fallback: ScriptProcessor
        this.processorNode = this.audioContext.createScriptProcessor(4096, 1, 1);
        this.processorNode.onaudioprocess = (e) => {
            if (!this.isStreaming) return;
            const now = Date.now();
            if (now - this.lastAudioSent < this.audioSendInterval) return;
            this.lastAudioSent = now;

            const input = e.inputBuffer.getChannelData(0);
            // copy to Float32Array
            const copy = new Float32Array(input.length);
            copy.set(input);
            this.sendAudioToServer(copy.buffer);
        };
        this.sourceNode.connect(this.processorNode);
        // Ensure the processor is pulled by connecting to a muted gain -> destination
        if (!this.silentGainNode) {
            this.silentGainNode = this.audioContext.createGain();
            this.silentGainNode.gain.value = 0.0;
            this.silentGainNode.connect(this.audioContext.destination);
        }
        this.processorNode.connect(this.silentGainNode);
    }

    // Worklet code served as blob URL
    createAudioWorkletScript() {
        const workletScript = `
      class AudioProcessor extends AudioWorkletProcessor {
        constructor() {
          super();
          this.lastSent = 0;
          this.intervalMs = 20; // send every ~20ms
        }
        process(inputs) {
          const input = inputs[0];
          if (!input || !input[0]) return true;
          const now = currentTime * 1000; // ms
          if (now - this.lastSent < this.intervalMs) return true;
          this.lastSent = now;
          const channelData = input[0];
          // copy to Float32Array
          const copy = new Float32Array(channelData.length);
          copy.set(channelData);
          // post as transferable
          this.port.postMessage({ audioBuffer: copy.buffer }, [copy.buffer]);
          return true;
        }
      }
      registerProcessor('audio-processor', AudioProcessor);
    `;
        const blob = new Blob([workletScript], { type: 'application/javascript' });
        return URL.createObjectURL(blob);
    }

    sendAudioToServer(arrayBuffer) {
        this.socket.emit('audioData', {
            channel: 0,
            timestamp: Date.now(),
            data: arrayBuffer
        });
    }

    // ----- Listening / Playback -----
    async startListening(sourceId) {
        // Ensure AudioContext exists and is resumed
        if (!this.audioContext) {
            this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
        }
        if (this.audioContext.state === 'suspended') {
            await this.audioContext.resume();
        }

        // 🔊 PLAY TEST BEEP — to confirm audio playback works on phone
        try {
            const osc = this.audioContext.createOscillator();
            const gain = this.audioContext.createGain();
            gain.gain.value = 0.3; // not too loud
            osc.connect(gain).connect(this.audioContext.destination);
            osc.start();
            osc.stop(this.audioContext.currentTime + 0.4);
            console.log('✅ Test beep played on listener');
        } catch (err) {
            console.warn('Beep test failed:', err);
        }

        // Setup playback pipeline
        this.setupAudioPlayback();
        this.listeningToSource = sourceId;

    // Reset packet count
    this.packetCount = 0;
    // Tell server we want to listen to this source
    this.socket.emit('joinAsListener', sourceId);
    this.showToast('Joining as listener...', 'info');
    }

    stopListening() {
        if (!this.isListening && !this.listeningToSource) {
            // nothing to stop
        }
        this.isListening = false;
        this.listeningToSource = null;
        this.socket.emit('leaveAsListener');
        this.audioQueue = [];
        this.nextPlayTime = 0;
        this.isProcessingQueue = false;

        const listenStatus = document.getElementById('listenStatus');
        if (listenStatus) listenStatus.remove();

        const serverStatus = document.getElementById('serverStatus');
        if (serverStatus) {
            serverStatus.textContent = this.isStreaming ? 'LIVE' : 'ONLINE';
            serverStatus.className = this.isStreaming ? 'badge bg-success' : 'badge bg-success';
        }

        this.showToast('Stopped listening', 'info');
    }

    setupAudioPlayback() {
        if (!this.audioContext) return;
        if (!this.playbackGainNode) {
            this.playbackGainNode = this.audioContext.createGain();
            this.playbackGainNode.connect(this.audioContext.destination);
            this.playbackGainNode.gain.value = 1.0;
        }
    }

    playAudioData(streamData) {
        if (!this.audioContext) return;
        if (!streamData || !streamData.data) return;

        // streamData.data may be ArrayBuffer or Array
        let floatArr;
        if (streamData.data instanceof ArrayBuffer) {
            floatArr = new Float32Array(streamData.data);
        } else if (Array.isArray(streamData.data)) {
            floatArr = new Float32Array(streamData.data);
        } else {
            console.warn('Unsupported audio format from server');
            this.showToast('Unsupported audio format from server', 'error');
            return;
        }

        this.audioQueue.push({
            data: floatArr,
            timestamp: streamData.timestamp || Date.now()
        });

        if (!this.isProcessingQueue) this.processAudioQueue();
    }

    async processAudioQueue() {
        if (this.isProcessingQueue) return;
        this.isProcessingQueue = true;

        while (this.audioQueue.length) {
            const item = this.audioQueue.shift();
            try {
                const buffer = this.audioContext.createBuffer(1, item.data.length, this.audioContext.sampleRate);
                buffer.getChannelData(0).set(item.data);

                const src = this.audioContext.createBufferSource();
                src.buffer = buffer;
                src.connect(this.playbackGainNode);

                const now = this.audioContext.currentTime;
                if (this.nextPlayTime <= now) this.nextPlayTime = now + this.audioLatency;
                src.start(this.nextPlayTime);
                this.nextPlayTime += buffer.duration;

                // allow tiny delay for scheduling
                await new Promise(resolve => setTimeout(resolve, 5));
            } catch (err) {
                this.showToast('Audio playback error: ' + (err.message || err), 'error');
            }
        }

        this.isProcessingQueue = false;
    }

    // ----- UI / helpers -----
    updateDeviceList(devices) {
        const deviceList = document.getElementById('deviceList');
        if (!deviceList) return;

        if (!devices || devices.length === 0) {
            deviceList.innerHTML = '<div class="text-muted p-3">No devices found</div>';
            return;
        }

        deviceList.innerHTML = devices.map(d => {
            const live = d.isStreaming ? '<span class="badge bg-success me-1">LIVE</span>' : '';
            const listenBtn = d.isStreaming ? `<button class="btn btn-sm btn-success" onclick="app.connectToDevice('${d.id}')"><i class="bi bi-headphones me-1"></i>Listen</button>` : `<button class="btn btn-sm btn-secondary" disabled>Not streaming</button>`;
            return `
        <div class="card mb-2 p-2">
          <div class="d-flex justify-content-between align-items-center">
            <div>
              <strong>${d.name}</strong> ${live} <br>
              <small class="font-monospace">${d.ip}:${d.port}</small>
            </div>
            <div>${listenBtn}</div>
          </div>
        </div>
      `;
        }).join('');
    }

    connectToDevice(deviceId) {
        // send a connect request; the server will respond with joinedAsListener and audioStream events
        this.startListening(deviceId);
    }

    updateListeningUI(sourceName) {
                let listenStatus = document.getElementById('listenStatus');
                if (!listenStatus) {
                        const playCardBody = document.querySelector('#play .card-body') || document.body;
                        const html = `
                <div class="alert alert-info mb-3" id="listenStatus">
                    LISTENING TO: <strong id="listenSourceName">${sourceName}</strong>
                    <button class="btn btn-sm btn-outline-info float-end" onclick="app.stopListening()">Stop</button>
                    <div class="mt-2">Packets received: <span id="packetCount">0</span></div>
                </div>
            `;
                        playCardBody.insertAdjacentHTML('afterbegin', html);
                } else {
                        document.getElementById('listenSourceName').textContent = sourceName;
                        listenStatus.classList.remove('d-none');
                }

        const serverStatus = document.getElementById('serverStatus');
        if (serverStatus) {
            serverStatus.textContent = 'LISTENING';
            serverStatus.className = 'badge bg-info';
        }
        this.isListening = true;
    }

    manualConnect() {
        const manualIP = document.getElementById('manualIP')?.value?.trim();
        if (!manualIP) {
            this.showToast('Enter IP:PORT', 'warning');
            return;
        }
        const [ip, port] = manualIP.split(':');
        this.socket.emit('manualConnect', { ip, port: port ? parseInt(port) : 3001 });
    }

    filterDevices(query) {
        const q = query.trim().toLowerCase();
        document.querySelectorAll('#deviceList .card').forEach(card => {
            const txt = card.textContent.toLowerCase();
            card.style.display = txt.includes(q) ? '' : 'none';
        });
    }

    async getDeviceName() {
        try {
            const ua = navigator.userAgent;
            if (ua.includes('Windows')) return 'Windows PC';
            if (ua.includes('Mac')) return 'Mac';
            if (ua.includes('Linux')) return 'Linux';
            if (/Android/.test(ua)) return 'Android';
            if (/iPhone|iPad/.test(ua)) return 'iOS';
        } catch (e) { }
        return 'Unknown Device';
    }

    showToast(message, type = 'info') {
        const toastContainer = document.getElementById('toastContainer');
        if (!toastContainer) {
            console.log(`${type.toUpperCase()}:`, message);
            return;
        }

        const id = 't' + Date.now();
        const bg = type === 'error' ? 'bg-danger' : type === 'success' ? 'bg-success' : type === 'warning' ? 'bg-warning' : 'bg-info';
        const html = `
      <div id="${id}" class="toast ${bg} text-white align-items-center" role="alert" aria-live="assertive" aria-atomic="true" style="min-width:200px; margin-bottom:6px;">
        <div class="d-flex">
          <div class="toast-body">${message}</div>
          <button type="button" class="btn-close btn-close-white me-2 m-auto" data-bs-dismiss="toast" aria-label="Close"></button>
        </div>
      </div>`;
        toastContainer.insertAdjacentHTML('beforeend', html);
        const el = document.getElementById(id);
        try {
            const bsToast = new bootstrap.Toast(el, { delay: 4000 });
            bsToast.show();
            el.addEventListener('hidden.bs.toast', () => el.remove());
        } catch (e) {
            setTimeout(() => el.remove(), 4000);
        }
    }
}

// expose globally
window.app = new AudioTransferApp();
