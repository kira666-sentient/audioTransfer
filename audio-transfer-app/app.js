// app.js - Final tuned client: removed experimental toggles, fixed channel handling (stereo / dual-mono / mono), high-quality resampling

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
    this.fadeTime = 0.0008; // 0.8ms conditional fade-in (reduces modulation artifacts)
    this.underruns = 0; // count scheduling catch-ups
    this.lastTailSamples = null; // store last few samples of previous buffer for continuity check
    // Monotonic playback scheduler: track cumulative samples scheduled (improves robustness vs floating time drift)
    this.playCursorSamples = 0; // advances by buffer length; converted to time via sampleRate
    this._anchorTime = 0; // wall-clock time corresponding to playCursorSamples == 0
    // Feature toggles for rapid A/B testing of artifact sources
    this.features = {
      adaptiveLatency: false, // DISABLED: timing changes cause crackling
      seqGapSilenceInsert: false, // DISABLED: silence insertion can cause pops
      conditionalFade: true, // ONLY keep basic fade-in
      overlapAdd: false, // DISABLED: complex crossfade causing issues
      dcOffsetCorrection: false, // DISABLED: can cause artifacts
      coalescePackets: false, // DISABLED: was creating periodic beep artifacts at coalesce boundaries
      boundarySlopeCorrection: false, // DISABLED: slope correction causing artifacts
      boundaryDither: false // DISABLED: dither causing artifacts
    };
    this.crossfadeMs = 0.002; // 2ms overlap-add window
    this.coalesce = { data: [], samples: 0, channels: null, sampleRate: null, lastTs: 0, maxMs: 40 };
    this.baseLatency = this.fixedLatency; // remember mode baseline for adaptive adjustments
    this.latencyAdjustTimer = null; // interval handle for adaptive latency
    this.deviceRefreshTimer = null; // interval handle for periodic rediscovery
    this.lastSeqMap = {}; // track last sequence per source for gap detection

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

  init() {
    this.initSocket();
    this.setupEventListeners();
    this.detectLocalIP();
    // periodic passive device rediscovery (covers cases where a broadcast was missed)
    if (!this.deviceRefreshTimer) {
      this.deviceRefreshTimer = setInterval(() => {
        try {
          if (document.hidden) return; // don't spam while tab hidden
          if (this.socket && this.socket.connected) {
            this.discoverDevices();
          }
        } catch (_) { }
      }, 7000);
    }
    // adaptive latency manager – gently increases on underruns / reduces when stable
    if (this.features.adaptiveLatency && !this.latencyAdjustTimer) {
      this.latencyAdjustTimer = setInterval(() => this.autoAdjustLatency(), 2000);
    }
  }

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

    this.socket.on('disconnect', (reason) => {
      console.log('Disconnected from server:', reason);
      const s = document.getElementById('serverStatus');
      if (s) { s.textContent = 'OFFLINE'; s.className = 'badge bg-secondary'; }
    });

    this.socket.on('connect_error', (error) => {
      console.error('Connection error:', error);
      this.showToast('Connection failed. Check server address.', 'error');
    });

    this.socket.on('deviceList', (devices) => this.updateDeviceList(devices));

    this.socket.on('streamStarted', (info) => {
      this.showToast(`${info.clientName || 'Device'} started streaming`, 'success');
      this.socket.emit('discoverDevices');
    });

    this.socket.on('streamStopped', (info) => {
      this.showToast(`${info.clientName || 'Device'} stopped streaming`, 'info');
      this.socket.emit('discoverDevices');
      if (this.listeningToSource === info.clientId) this.stopListening();
    });

    // audioStream: { sourceId, sampleRate, channels, timestamp, data: ArrayBuffer/TypedArray }
    this.socket.on('audioStream', (streamData) => {
      try {
        this.packetCount++;
        const pc = document.getElementById('packetCount');
        if (pc) pc.textContent = this.packetCount;
        // Sequence gap detection to avoid bursty distortions (radio noise)
        if (streamData && typeof streamData.seq === 'number') {
          const last = this.lastSeqMap[streamData.sourceId];
          if (last != null) {
            const gap = streamData.seq - last;
            if (gap > 200) {
              // Only reset on massive gaps (major network disruption/reconnection)
              this.nextPlayTime = 0;
            } else if (gap > 25 && this.features.seqGapSilenceInsert) {
              // Moderate gap: insert ~10ms silence only for significant drops
              const ch = streamData.channels || 1;
              const sr = streamData.sampleRate || 48000;
              const silenceFrames = Math.round(sr * 0.01); // 10ms
              const silence = new Float32Array(silenceFrames * ch); // zeros
              this.audioQueue.push({ data: silence, channels: ch, sampleRate: sr, timestamp: Date.now() - 5 });
            }
          }
          this.lastSeqMap[streamData.sourceId] = streamData.seq;
        }
        if (this.isListening && this.listeningToSource === streamData.sourceId) {
          if (this.features.coalescePackets) {
            const ch = streamData.channels || 1;
            const sr = streamData.sampleRate || 48000;
            if (this.coalesce.channels == null) this.coalesce.channels = ch;
            if (this.coalesce.sampleRate == null) this.coalesce.sampleRate = sr;
            // Flush immediately if channel or sampleRate changes mid-session
            if ((this.coalesce.channels !== ch || this.coalesce.sampleRate !== sr) && this.coalesce.data.length) {
              const totalElems = this.coalesce.data.reduce((a, b) => a + b.length, 0);
              const merged = new Float32Array(totalElems); let o = 0; for (const seg of this.coalesce.data) { merged.set(seg, o); o += seg.length; }
              this.playAudioData({ sourceId: streamData.sourceId, sampleRate: this.coalesce.sampleRate, channels: this.coalesce.channels, timestamp: this.coalesce.lastTs, data: merged });
              this.coalesce.data = []; this.coalesce.samples = 0;
              this.coalesce.channels = ch; this.coalesce.sampleRate = sr;
            }
            const dataArr = new Float32Array(streamData.data instanceof ArrayBuffer ? streamData.data : (ArrayBuffer.isView(streamData.data) ? streamData.data.buffer.slice(streamData.data.byteOffset, streamData.data.byteOffset + streamData.data.byteLength) : streamData.data));
            this.coalesce.data.push(dataArr);
            this.coalesce.samples += dataArr.length / ch;
            this.coalesce.lastTs = streamData.timestamp || Date.now();
            const targetFrames = Math.round(sr * (this.coalesce.maxMs / 1000));
            // Flush if over time, enough frames, or partial chunk idles > maxMs * 1.5
            if (this.coalesce.samples * 1000 / sr >= this.coalesce.maxMs || this.coalesce.data.length >= 2 || (Date.now() - this.coalesce.lastTs) > (this.coalesce.maxMs * 1.5)) {
              // merge
              const totalElems = this.coalesce.data.reduce((a, b) => a + b.length, 0);
              const merged = new Float32Array(totalElems);
              let offset = 0; for (const seg of this.coalesce.data) { merged.set(seg, offset); offset += seg.length; }
              const mergedPayload = {
                sourceId: streamData.sourceId,
                sampleRate: sr,
                channels: ch,
                timestamp: this.coalesce.lastTs,
                data: merged
              };
              this.coalesce.data = []; this.coalesce.samples = 0;
              this.playAudioData(mergedPayload);
            }
          } else {
            this.playAudioData(streamData);
          }
        }
      } catch (e) {
        console.warn('audioStream handler', e);
      }
    });

    this.socket.on('joinedAsListener', (info) => {
      this.isListening = true;
      this.listeningToSource = info.sourceId;
      this.updateListeningUI(info.sourceName || 'Unknown');
    });

    // keep rateLimit handling but unobtrusive
    this.socket.on('rateLimitWarning', () => {
      this.showToast('Server requested rate reduction', 'warning');
    });
  }

  setupEventListeners() {
    document.getElementById('startStreamBtn')?.addEventListener('click', () => this.startStreaming());
    document.getElementById('stopStreamBtn')?.addEventListener('click', () => this.stopStreaming());
    document.getElementById('refreshDevices')?.addEventListener('click', () => this.discoverDevices());
    document.getElementById('manualConnect')?.addEventListener('click', () => this.manualConnect());
    document.getElementById('deviceSearch')?.addEventListener('input', (e) => this.filterDevices(e.target.value));

    // Playback controls
    this.setupPlaybackControls();
  }

  async detectLocalIP() {
    try {
      const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
      pc.createDataChannel('');
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      const localIP = await new Promise((resolve, reject) => {
        pc.onicecandidate = (ev) => {
          if (!ev.candidate) return;
          const c = ev.candidate.candidate;
          const m = c.match(/(\d+\.\d+\.\d+\.\d+)/);
          if (m) { resolve(m[1]); pc.close(); }
        };
        setTimeout(() => reject(new Error('timeout')), 1700);
      });
      const el = document.getElementById('localIP');
      if (el) el.textContent = `${localIP}:3001`;
    } catch {
      const el = document.getElementById('localIP');
      if (el) el.textContent = 'localhost:3001';
    }
  }

  discoverDevices() { if (this.socket) this.socket.emit('discoverDevices'); }

  // ---------------- SENDER ----------------
  async getMediaStream(source, quality) {
    const q = {
      low: { sampleRate: 22050, channelCount: 1 },
      medium: { sampleRate: 44100, channelCount: 1 },
      high: { sampleRate: 44100, channelCount: 2 },
      ultra: { sampleRate: 48000, channelCount: 2 }
    };
    const settings = q[quality] || q.high;
    if (source === 'microphone') {
      try {
        // For higher qualities disable browser DSP that can cause metallic artifacts
        const highTier = quality === 'high' || quality === 'ultra';
        return await navigator.mediaDevices.getUserMedia({
          audio: {
            sampleRate: settings.sampleRate,
            channelCount: settings.channelCount,
            echoCancellation: highTier ? false : true,
            noiseSuppression: highTier ? false : true,
            autoGainControl: false // keep off for consistent dynamics
          }
        });
      } catch (err) {
        if (err.name === 'NotAllowedError') {
          throw new Error('Microphone access denied. Please allow microphone access and try again.');
        } else if (err.name === 'NotFoundError') {
          throw new Error('No microphone found. Please connect a microphone and try again.');
        } else {
          throw new Error(`Microphone error: ${err.message}`);
        }
      }
    }
    if (source === 'system') {
      try {
        const stream = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: true });
        stream.getVideoTracks().forEach(t => t.stop());
        if (!stream.getAudioTracks().length) {
          stream.getTracks().forEach(t => t.stop());
          throw new Error('System audio not available. Make sure to check "Share audio" when sharing your screen.');
        }
        return stream;
      } catch (err) {
        if (err.name === 'NotAllowedError') {
          throw new Error('Screen sharing denied. Please allow screen sharing and enable audio.');
        } else {
          throw new Error(`System audio error: ${err.message}`);
        }
      }
    }
    if (source === 'file') {
      // Create file input and get audio file
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'audio/*';
      input.style.display = 'none';
      document.body.appendChild(input);

      return new Promise((resolve, reject) => {
        input.onchange = async (e) => {
          try {
            const file = e.target.files[0];
            if (!file) { reject(new Error('No file selected')); return; }

            const audio = new Audio();
            audio.src = URL.createObjectURL(file);
            await audio.play();

            // Create MediaStream from audio element
            const audioContext = new (window.AudioContext || window.webkitAudioContext)();
            const audioSource = audioContext.createMediaElementSource(audio);
            const dest = audioContext.createMediaStreamDestination();
            audioSource.connect(dest);

            // Loop the audio file
            audio.loop = true;

            resolve(dest.stream);
          } catch (err) {
            reject(err);
          } finally {
            document.body.removeChild(input);
          }
        };
        input.click();
      });
    }
    throw new Error('Unknown source');
  }

  async startStreaming() {
    try {
      // Check for mobile browser limitations
      const isMobile = /Android|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
      if (isMobile && location.protocol !== 'https:' && location.hostname !== 'localhost') {
        this.showToast('HTTPS required for mobile devices. Use https:// in the URL.', 'error');
        return;
      }

      const startBtn = document.getElementById('startStreamBtn');
      const stopBtn = document.getElementById('stopStreamBtn');
      const liveIndicator = document.getElementById('liveIndicator');
      const serverStatus = document.getElementById('serverStatus');

      if (startBtn) { startBtn.disabled = true; startBtn.innerHTML = 'Starting...'; }

      const source = (document.querySelector('input[name="audioSource"]:checked') || {}).value || 'microphone';
      const quality = (document.querySelector('input[name="quality"]:checked') || {}).value || 'high';

      // Check browser capabilities
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        throw new Error('Your browser does not support audio capture. Please use Chrome, Firefox, or Safari.');
      }

      if (source === 'system' && !navigator.mediaDevices.getDisplayMedia) {
        throw new Error('System audio capture not supported in this browser.');
      }

      this.mediaStream = await this.getMediaStream(source, quality);

      // Capture context: use default sampleRate (browser chosen) but capture sampleRate metadata will be sent
      this.captureContext = new (window.AudioContext || window.webkitAudioContext)();
      this.captureSourceNode = this.captureContext.createMediaStreamSource(this.mediaStream);

      // muted gain to keep graph alive, avoid feedback
      this.silentGainNode = this.captureContext.createGain();
      this.silentGainNode.gain.value = 0;
      this.silentGainNode.connect(this.captureContext.destination);

      // prefer AudioWorklet
      try {
        const url = this.createCaptureWorkletScript();
        await this.captureContext.audioWorklet.addModule(url);
        this.workletNode = new AudioWorkletNode(this.captureContext, 'capture-processor');
        this.workletNode.port.onmessage = (ev) => {
          if (!this.socket) return;
          const d = ev.data;
          const payload = {
            seq: ++this._sendSeq,
            sampleRate: d.sampleRate || this.captureContext.sampleRate,
            channels: d.channels || 1,
            timestamp: Date.now(),
            data: d.audioBuffer
          };
          this.socket.emit('audioData', payload);
        };
        this.captureSourceNode.connect(this.workletNode);
        this.workletNode.connect(this.silentGainNode);
      } catch (err) {
        // fallback ScriptProcessor: produce interleaved Float32 packets (~20ms)
        const buf = 2048;
        this.processorNode = this.captureContext.createScriptProcessor(buf, this.captureSourceNode.channelCount || 1, this.captureSourceNode.channelCount || 1);

        const framesPerPacket = Math.round(this.captureContext.sampleRate * 0.02);
        const pending = [];
        let pendingFrames = 0;

        this.processorNode.onaudioprocess = (e) => {
          if (!this.isStreaming) return;
          const chCount = e.inputBuffer.numberOfChannels;
          const frameLen = e.inputBuffer.length;
          // interleave channels
          const inter = new Float32Array(frameLen * chCount);
          for (let c = 0; c < chCount; c++) {
            const ch = e.inputBuffer.getChannelData(c);
            for (let i = 0; i < frameLen; i++) inter[i * chCount + c] = ch[i];
          }
          pending.push(inter);
          pendingFrames += frameLen;
          while (pendingFrames >= framesPerPacket) {
            const out = new Float32Array(framesPerPacket * chCount);
            let filled = 0;
            while (filled < framesPerPacket && pending.length) {
              const head = pending[0];
              const headFrames = head.length / chCount;
              const need = framesPerPacket - filled;
              if (headFrames <= need) {
                out.set(head, filled * chCount);
                filled += headFrames;
                pending.shift();
              } else {
                out.set(head.subarray(0, need * chCount), filled * chCount);
                pending[0] = head.subarray(need * chCount);
                filled += need;
              }
            }
            pendingFrames -= framesPerPacket;
            if (this.socket) {
              const payload = {
                seq: ++this._sendSeq,
                sampleRate: this.captureContext.sampleRate,
                channels: chCount,
                timestamp: Date.now(),
                data: out.buffer
              };
              this.socket.emit('audioData', payload);
            }
          }
        };

        this.captureSourceNode.connect(this.processorNode);
        this.processorNode.connect(this.silentGainNode);
      }

      const name = await this.getDeviceName();
      this.socket.emit('startStreaming', { source, quality, deviceName: name });

      this.isStreaming = true;
      if (startBtn) startBtn.classList.add('d-none');
      if (stopBtn) stopBtn.classList.remove('d-none');
      if (liveIndicator) liveIndicator.classList.remove('d-none');
      if (serverStatus) { serverStatus.textContent = 'LIVE'; serverStatus.className = 'badge bg-success'; }

      this.showToast('Streaming started', 'success');
    } catch (e) {
      console.error('startStreaming error', e);
      this.showToast('Failed to start streaming: ' + (e.message || e), 'error');
      const startBtn = document.getElementById('startStreamBtn');
      if (startBtn) { startBtn.disabled = false; startBtn.innerHTML = '<i class="bi bi-play-fill me-2"></i>Start Streaming'; }
    }
  }

  async stopStreaming() {
    try {
      if (this.mediaStream) { this.mediaStream.getTracks().forEach(t => t.stop()); this.mediaStream = null; }
      if (this.captureSourceNode) { try { this.captureSourceNode.disconnect(); } catch (_) { } this.captureSourceNode = null; }
      if (this.workletNode) { try { this.workletNode.disconnect(); } catch (_) { } this.workletNode = null; }
      if (this.processorNode) { try { this.processorNode.disconnect(); } catch (_) { } this.processorNode = null; }
      if (this.silentGainNode) { try { this.silentGainNode.disconnect(); } catch (_) { } this.silentGainNode = null; }
      if (this.captureContext && this.captureContext.state !== 'closed') { try { await this.captureContext.close(); } catch (_) { } }
      this.captureContext = null;

      if (this.socket) this.socket.emit('stopStreaming');
      this.isStreaming = false;

      const startBtn = document.getElementById('startStreamBtn');
      const stopBtn = document.getElementById('stopStreamBtn');
      const liveIndicator = document.getElementById('liveIndicator');
      const serverStatus = document.getElementById('serverStatus');

      if (stopBtn) stopBtn.classList.add('d-none');
      if (startBtn) startBtn.classList.remove('d-none');
      if (liveIndicator) liveIndicator.classList.add('d-none');
      if (startBtn) { startBtn.disabled = false; startBtn.innerHTML = '<i class="bi bi-play-fill me-2"></i>Start Streaming'; }

      if (!this.isListening && serverStatus) { serverStatus.textContent = 'OFFLINE'; serverStatus.className = 'badge bg-secondary'; }
      else if (serverStatus) { serverStatus.textContent = 'LISTENING'; serverStatus.className = 'badge bg-info'; }

      this.showToast('Stopped streaming', 'info');
    } catch (e) {
      console.error('stopStreaming error', e);
      this.showToast('Error stopping stream', 'error');
    }
  }

  createCaptureWorkletScript() {
    const code = `
      class CaptureProcessor extends AudioWorkletProcessor {
        constructor() {
          super();
          this.framesPerPacket = Math.max(1, Math.round(sampleRate * 0.02));
          this.pending = [];
          this.pendingFrames = 0;
        }
        process(inputs) {
          const input = inputs[0];
          if (!input || !input[0]) return true;
          const channels = input.length;
          const frameLen = input[0].length;
          const inter = new Float32Array(frameLen * channels);
          for (let c = 0; c < channels; c++) {
            const data = input[c];
            for (let i = 0; i < frameLen; i++) inter[i * channels + c] = data[i];
          }
          this.pending.push(inter);
          this.pendingFrames += frameLen;
          while (this.pendingFrames >= this.framesPerPacket) {
            const out = new Float32Array(this.framesPerPacket * channels);
            let filled = 0;
            while (filled < this.framesPerPacket && this.pending.length) {
              const head = this.pending[0];
              const headFrames = head.length / channels;
              const need = this.framesPerPacket - filled;
              if (headFrames <= need) {
                out.set(head, filled * channels);
                filled += headFrames;
                this.pending.shift();
              } else {
                out.set(head.subarray(0, need * channels), filled * channels);
                this.pending[0] = head.subarray(need * channels);
                filled += need;
              }
            }
            this.pendingFrames -= this.framesPerPacket;
            this.port.postMessage({ audioBuffer: out.buffer, frameSamples: this.framesPerPacket, sampleRate, channels }, [out.buffer]);
          }
          return true;
        }
      }
      registerProcessor('capture-processor', CaptureProcessor);
    `;
    return URL.createObjectURL(new Blob([code], { type: 'application/javascript' }));
  }

  // ---------------- LISTENER / PLAYBACK ----------------
  async startListening(sourceId) {
    try {
      if (!this.audioContext) this.audioContext = new (window.AudioContext || window.webkitAudioContext)();

      // Handle audio context suspension (common on mobile)
      if (this.audioContext.state === 'suspended') {
        await this.audioContext.resume();
        console.log('Audio context resumed');
      }

      // unlock audio with a tiny silent tick (cheap)
      try {
        const g = this.audioContext.createGain(); g.gain.value = 0.0001;
        const osc = this.audioContext.createOscillator();
        osc.connect(g).connect(this.audioContext.destination);
        osc.start(); osc.stop(this.audioContext.currentTime + 0.01);
      } catch (_) { }

      this.setupAudioPlayback();
      this.listeningToSource = sourceId;
      this.isListening = true;
      this.packetCount = 0;

      if (this.socket) {
        if (!this.socket.connected) {
          this.showToast('Not connected to server. Reconnecting...', 'warning');
          this.socket.connect();
          // Wait a bit for connection
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
        this.socket.emit('joinAsListener', sourceId);
      } else {
        throw new Error('Socket connection not available');
      }

      this.showToast('Joining as listener...', 'info');

      // mark button without full device list refresh
      this.markDeviceButtonListening(sourceId, true);
      this.updatePlaybackStatus();
    } catch (error) {
      console.error('Start listening error:', error);
      this.showToast(`Failed to start listening: ${error.message}`, 'error');
      this.isListening = false;
      this.listeningToSource = null;
      this.updatePlaybackStatus();
    }
  }

  stopListening() {
    if (!this.isListening && !this.listeningToSource) return;
    const prev = this.listeningToSource;
    this.isListening = false;
    this.listeningToSource = null;
    if (this.socket) this.socket.emit('leaveAsListener');

    this.audioQueue = [];
    this.isProcessingQueue = false;
    this.nextPlayTime = 0;
    for (const s of Array.from(this.activeSources)) { try { s.stop(0); s.disconnect(); } catch (_) { } }
    this.activeSources.clear();

    // Hide the listening status UI
    const listenStatus = document.getElementById('listenStatus');
    if (listenStatus) {
      listenStatus.remove();
    }

    if (prev) this.markDeviceButtonListening(prev, false);

    const serverStatus = document.getElementById('serverStatus');
    if (serverStatus) {
      serverStatus.textContent = this.isStreaming ? 'LIVE' : 'ONLINE';
      serverStatus.className = this.isStreaming ? 'badge bg-success' : 'badge bg-secondary';
    }
    this.showToast('Stopped listening', 'info');
    this.updatePlaybackStatus();
  }

  setupPlaybackControls() {
    // Volume control
    const volumeSlider = document.getElementById('playbackVolume');
    if (volumeSlider) {
      volumeSlider.addEventListener('input', (e) => {
        const volume = parseFloat(e.target.value) / 100;
        if (this.playbackGain) {
          this.playbackGain.gain.setValueAtTime(volume, this.audioContext.currentTime);
        }
      });
    }

    // EQ controls
    document.querySelectorAll('.eq-band').forEach(slider => {
      slider.addEventListener('input', (e) => {
        const band = e.target.dataset.band;
        const gain = parseFloat(e.target.value);
        if (this.eqNodes[band]) {
          this.eqNodes[band].gain.setValueAtTime(gain, this.audioContext?.currentTime || 0);
        }
      });
    });

    // EQ presets
    const eqPresetSelect = document.getElementById('eqPreset');
    if (eqPresetSelect) {
      eqPresetSelect.addEventListener('change', (e) => {
        this.applyEQPreset(e.target.value);
      });
    }

    // Playback mode
    document.querySelectorAll('input[name="playbackMode"]').forEach(radio => {
      radio.addEventListener('change', (e) => {
        if (e.target.checked) {
          this.playbackMode = e.target.id.replace('mode', '').toLowerCase();
          this.updatePlaybackMode();
        }
      });
    });

    // Other controls
    document.getElementById('resetSync')?.addEventListener('click', () => this.resetSync());

    // Loudness boost
    document.getElementById('loudnessBoost')?.addEventListener('change', (e) => {
      this.toggleLoudnessBoost(e.target.checked);
    });
  }

  applyEQPreset(preset) {
    const presets = {
      flat: { 60: 0, 250: 0, 1000: 0, 4000: 0, 12000: 0 },
      bass: { 60: 6, 250: 3, 1000: 0, 4000: -1, 12000: 0 },
      treble: { 60: 0, 250: -1, 1000: 0, 4000: 3, 12000: 6 },
      vshape: { 60: 4, 250: 0, 1000: -2, 4000: 0, 12000: 4 },
      voice: { 60: -2, 250: 2, 1000: 4, 4000: 3, 12000: -1 },
      warm: { 60: 2, 250: 1, 1000: 0, 4000: -1, 12000: -2 }
    };

    const settings = presets[preset] || presets.flat;
    Object.entries(settings).forEach(([band, gain]) => {
      const slider = document.querySelector(`[data-band="${band}"]`);
      if (slider) {
        slider.value = gain;
        if (this.eqNodes[band]) {
          this.eqNodes[band].gain.setValueAtTime(gain, this.audioContext?.currentTime || 0);
        }
      }
    });
  }

  updatePlaybackMode() {
    const modes = {
      lowlat: { latency: 0.08 },
      ultralow: { latency: 0.04 },
      highstab: { latency: 0.20 }
    };

    const mode = modes[this.playbackMode] || modes.lowlat;
    this.fixedLatency = mode.latency;
    this.updatePlaybackStatus();
  }

  resetSync() {
    this.nextPlayTime = 0;
    this.audioQueue = [];
    for (const source of this.activeSources) {
      try { source.stop(0); } catch (_) { }
    }
    this.activeSources.clear();
    this.showToast('Audio sync reset', 'info');
    this.updatePlaybackStatus();
  }



  toggleLoudnessBoost(enabled) {
    if (!this.audioContext) return;

    if (enabled && !this.compressorNode) {
      this.compressorNode = this.audioContext.createDynamicsCompressor();
      this.compressorNode.threshold.setValueAtTime(-18, this.audioContext.currentTime);
      this.compressorNode.knee.setValueAtTime(6, this.audioContext.currentTime);
      this.compressorNode.ratio.setValueAtTime(3, this.audioContext.currentTime);
      this.compressorNode.attack.setValueAtTime(0.003, this.audioContext.currentTime);
      this.compressorNode.release.setValueAtTime(0.1, this.audioContext.currentTime);
    }

    // Reconnect audio chain when toggling
    this.setupAudioPlayback();
    this.updatePlaybackStatus();
  }

  updatePlaybackStatus() {
    const el = document.getElementById('playbackStatus');
    if (!el) return;
    const listening = this.isListening ? `listening to ${this.listeningToSource || 'source'}` : 'idle';
    const queueMs = this.audioQueue.reduce((acc, item) => {
      const ch = item.channels || 1;
      return acc + (item.data.length / (item.sampleRate * ch)) * 1000;
    }, 0).toFixed(0);
    const modeMap = { lowlat: 'Low', ultralow: 'Ultra', highstab: 'Stable' };
    const modeLabel = modeMap[this.playbackMode] || 'Low';
    const uPart = this.features.adaptiveLatency ? ` • U:${this.underruns}` : '';
    let latPart = `Lat ${Math.round(this.fixedLatency * 1000)}ms`;
    if (this.features.adaptiveLatency) {
      const delta = this.fixedLatency - this.baseLatency;
      if (delta > 0.005) {
        latPart += ` (+${Math.round(delta * 1000)}ms)`;
      }
    }
    el.textContent = `${modeLabel} • ${latPart} • Queue ${queueMs}ms${uPart} • ${listening}`;
  }

  autoAdjustLatency() {
    // Adaptive latency: increase if multiple underruns in the last window, decrease slowly if stable
    if (!this.isListening) return;

    // CRITICAL: Only adjust latency when queue is low to avoid disrupting active crossfade smoothing
    // This prevents grainy artifacts caused by timing changes during sustained audio
    if (this.audioQueue.length > 2) return;

    this._lastUnderrunsWindow = this._lastUnderrunsWindow || 0;
    const diff = this.underruns - this._lastUnderrunsWindow;
    this._lastUnderrunsWindow = this.underruns;
    const now = performance.now();
    this._lastLatencyRaiseTime = this._lastLatencyRaiseTime || 0;
    // Require sustained underruns: diff >=3 and at least 500ms since last bump
    if (diff >= 3 && (now - this._lastLatencyRaiseTime) > 500 && this.fixedLatency < this.baseLatency + 0.20) {
      this.fixedLatency = +(this.fixedLatency + 0.01).toFixed(3); // +10ms
      this._lastLatencyRaiseTime = now;
      this.showToast(`Latency +10ms -> ${Math.round(this.fixedLatency * 1000)}ms`, 'warning');
    } else if (diff === 0 && this.fixedLatency - this.baseLatency > 0.03) {
      // decay only every other call (~4s) using a toggle flag to slow reduction
      this._decayToggle = !this._decayToggle;
      if (this._decayToggle) {
        this.fixedLatency = +(this.fixedLatency - 0.005).toFixed(3); // -5ms
      }
    }
    this.updatePlaybackStatus();
  }

  setupAudioPlayback() {
    if (!this.audioContext) return;

    // Create EQ nodes if they don't exist
    const eqBands = [60, 250, 1000, 4000, 12000];
    eqBands.forEach(freq => {
      if (!this.eqNodes[freq]) {
        const filter = this.audioContext.createBiquadFilter();
        if (freq === 60) {
          filter.type = 'lowshelf';
        } else if (freq === 12000) {
          filter.type = 'highshelf';
        } else {
          filter.type = 'peaking';
          filter.Q.value = 1;
        }
        filter.frequency.value = freq;
        filter.gain.value = 0;
        this.eqNodes[freq] = filter;
      }
    });

    // Create main playback gain if it doesn't exist
    if (!this.playbackGain) {
      this.playbackGain = this.audioContext.createGain();
      this.playbackGain.gain.value = 1.0;
    }

    // Setup audio processing chain: EQ -> Compressor (if enabled) -> Gain -> Destination
    let currentNode = this.eqNodes[60];
    eqBands.slice(1).forEach(freq => {
      currentNode.connect(this.eqNodes[freq]);
      currentNode = this.eqNodes[freq];
    });

    // Connect compressor if loudness boost is enabled
    if (this.compressorNode) {
      currentNode.connect(this.compressorNode);
      this.compressorNode.connect(this.playbackGain);
    } else {
      currentNode.connect(this.playbackGain);
    }

    this.playbackGain.connect(this.audioContext.destination);

    if (!this.nextPlayTime) this.nextPlayTime = this.audioContext.currentTime + this.fixedLatency;
  }

  // Play audioData: resample if needed and preserve channels (stereo -> stereo; dual-mono -> dual-mono; mono -> mono)
  async playAudioData(streamData) {
    if (!this.audioContext) return;
    if (!streamData || !streamData.data) return;

    // normalize incoming buffer to ArrayBuffer
    let srcBuffer;
    if (streamData.data instanceof ArrayBuffer) srcBuffer = streamData.data;
    else if (ArrayBuffer.isView(streamData.data)) srcBuffer = streamData.data.buffer.slice(streamData.data.byteOffset, streamData.data.byteOffset + streamData.data.byteLength);
    else if (Array.isArray(streamData.data)) { const t = new Float32Array(streamData.data.length); t.set(streamData.data); srcBuffer = t.buffer; }
    else { console.warn('unsupported audio payload'); return; }

    const srcRate = streamData.sampleRate || 48000;
    const channels = streamData.channels || 1;

    // interpret as Float32Array interleaved
    let interleaved = new Float32Array(srcBuffer);

    // If incoming channels >1 keep channels as-is. We'll resample preserving channels.
    // Resample using OfflineAudioContext for best quality if sampleRate mismatch.
    const targetRate = this.audioContext.sampleRate;
    let processedInterleaved = interleaved;
    let processedChannels = channels;

    if (srcRate !== targetRate) {
      try {
        processedInterleaved = await this.resampleInterleaved(interleaved, srcRate, targetRate, channels);
      } catch (e) {
        console.warn('resample error, using raw buffer', e);
      }
    }

    // push to queue (preserve channels exactly as coming)
    this.audioQueue.push({ data: processedInterleaved, channels: processedChannels, sampleRate: targetRate, timestamp: streamData.timestamp || Date.now() });
    this.updatePlaybackStatus();

    if (!this.isProcessingQueue) this.processAudioQueue();
  }

  async resampleInterleaved(interleaved, srcRate, dstRate, channels) {
    if (srcRate === dstRate) return interleaved.slice(0);
    const srcFrames = Math.floor(interleaved.length / channels);
    const dstFrames = Math.ceil(srcFrames * dstRate / srcRate);

    // create offline at srcRate to hold source buffer
    const srcOffline = new (window.OfflineAudioContext || window.webkitOfflineAudioContext)(channels, srcFrames, srcRate);
    const srcBuf = srcOffline.createBuffer(channels, srcFrames, srcRate);
    for (let ch = 0; ch < channels; ch++) {
      const chData = srcBuf.getChannelData(ch);
      for (let i = 0, k = ch; i < srcFrames; i++, k += channels) chData[i] = interleaved[k];
    }

    // render into offline at dstRate
    const offline = new (window.OfflineAudioContext || window.webkitOfflineAudioContext)(channels, dstFrames, dstRate);
    const srcNode = offline.createBufferSource();
    srcNode.buffer = srcBuf;
    srcNode.connect(offline.destination);
    srcNode.start(0);
    const rendered = await offline.startRendering();

    const outFrames = rendered.length;
    const out = new Float32Array(outFrames * channels);
    for (let ch = 0; ch < channels; ch++) {
      const chData = rendered.getChannelData(ch);
      for (let i = 0; i < outFrames; i++) out[i * channels + ch] = chData[i];
    }
    return out;
  }

  async processAudioQueue() {
    if (this.isProcessingQueue) return;
    if (!this.audioContext) return;
    this.isProcessingQueue = true;

    while (this.audioQueue.length) {
      const item = this.audioQueue.shift();
      try {
        const ch = item.channels || 1;
        const frames = Math.floor(item.data.length / ch);

        const audioBuffer = this.audioContext.createBuffer(ch, frames, item.sampleRate || this.audioContext.sampleRate);
        for (let c = 0; c < ch; c++) {
          const chData = audioBuffer.getChannelData(c);
          for (let i = 0, k = c; i < frames; i++, k += ch) chData[i] = item.data[k];
        }

        const src = this.audioContext.createBufferSource();
        src.buffer = audioBuffer;

        // Connect through EQ chain if available, otherwise direct to gain
        if (this.eqNodes[60]) {
          src.connect(this.eqNodes[60]);
        } else {
          src.connect(this.playbackGain);
        }

        // SIMPLIFIED SCHEDULER: Use basic Web Audio timing
        const now = this.audioContext.currentTime;
        if (!this.nextPlayTime || this.nextPlayTime < now + 0.005) {
          this.nextPlayTime = now + this.fixedLatency;
        }
        const startAt = this.nextPlayTime;

        // CRITICAL: Validate audio data to prevent corrupted data crackling
        let hasCorruptedData = false;
        for (let c = 0; c < audioBuffer.numberOfChannels; c++) {
          const d = audioBuffer.getChannelData(c);
          for (let i = 0; i < d.length; i++) {
            if (!isFinite(d[i]) || Math.abs(d[i]) > 1.0) {
              hasCorruptedData = true;
              d[i] = 0; // zero out bad samples
            }
          }
        }
        
        if (hasCorruptedData) {
          console.warn('Corrupted audio data detected and cleaned');
        }

        try {
          // crossfade / smoothing
          const cfSamples = Math.max(1, Math.min(Math.floor(this.crossfadeMs * sampleRate), Math.floor(audioBuffer.length / 3)));
          // Optional DC offset correction
          if (this.features.dcOffsetCorrection) {
            for (let c = 0; c < audioBuffer.numberOfChannels; c++) {
              const d = audioBuffer.getChannelData(c);
              let sum = 0; for (let i = 0; i < d.length; i++) sum += d[i];
              const mean = sum / d.length; if (Math.abs(mean) > 1e-4) { for (let i = 0; i < d.length; i++) d[i] -= mean; }
            }
          }
          if (this.features.overlapAdd && !forceFadeIn) {
            for (let c = 0; c < audioBuffer.numberOfChannels; c++) {
              const d = audioBuffer.getChannelData(c);
              if (this.lastTailSamples && this.lastTailSamples[c]) {
                const prev = this.lastTailSamples[c];
                // ANTI-CRACKLING: Check for corrupted tail data
                const isCorrupted = prev.some(x => !isFinite(x) || Math.abs(x) > 1.0);
                if (isCorrupted) {
                  this.lastTailSamples = null;
                } else {
                  const overlap = Math.min(cfSamples, prev.length, d.length);
                  for (let i = 0; i < overlap; i++) {
                    const w = i / (overlap - 1 || 1); // 0..1
                    // Hann window for smoother spectral transition
                    const inW = 0.5 * (1 - Math.cos(Math.PI * w)); // 0..1
                    const prevW = 1 - inW;
                    d[i] = prev[prev.length - overlap + i] * prevW + d[i] * inW;
                  }
                  // Boundary slope correction: match initial derivative to previous tail to reduce voiced sustain grain
                  if (this.features.boundarySlopeCorrection && overlap >= 4) {
                    const prevTail = prev.subarray(prev.length - overlap);
                    const prevSlope = prevTail[overlap - 1] - prevTail[overlap - 2];
                    const curSlope = d[overlap - 1] - d[overlap - 2];
                    const slopeDiff = curSlope - prevSlope;
                    if (Math.abs(slopeDiff) > 1e-3) {
                      // apply very gentle linear correction over first 0.5 ms
                      const corrSamples = Math.min(Math.floor(sampleRate * 0.0005), d.length - 1);
                      for (let i = 0; i < corrSamples; i++) {
                        const f = (1 - i / (corrSamples - 1 || 1));
                        d[i] -= slopeDiff * 0.25 * f; // gentler taper
                      }
                    }
                  }
                  // Add ultra-low dither noise to mask residual deterministic boundary energy (first 0.3ms)
                  if (this.features.boundaryDither) {
                    const ditherSamples = Math.min(Math.floor(sampleRate * 0.0003), d.length);
                    for (let i = 0; i < ditherSamples; i++) {
                      // TPDF dither ~ ±2e-6 scaled by fade-out of effect
                      const n = ((Math.random() + Math.random()) - 1) * 2e-6 * (1 - i / (ditherSamples - 1 || 1));
                      d[i] += n;
                    }
                  }
                }
              } else if (this.features.conditionalFade) {
                const fadeIn = Math.min(cfSamples, d.length);
                for (let i = 0; i < fadeIn; i++) {
                  const w = 0.5 * (1 - Math.cos(Math.PI * i / (fadeIn - 1 || 1)));
                  d[i] *= w;
                }
              }
            }
          } else if (this.features.conditionalFade) {
            const fadeInSamples = Math.min(Math.floor(this.fadeTime * sampleRate), Math.floor(audioBuffer.length / 5));
            for (let c = 0; c < audioBuffer.numberOfChannels; c++) {
              const d = audioBuffer.getChannelData(c);
              for (let i = 0; i < fadeInSamples; i++) {
                const w = 0.5 * (1 - Math.cos(Math.PI * i / (fadeInSamples - 1 || 1)));
                d[i] *= w;
              }
            }
          }

          // ANTI-DRUM/BASS CRACKLING: Detect sudden volume jumps (drum hits, bass drops)
          let peak = 0;
          let maxChange = 0;
          for (let c = 0; c < audioBuffer.numberOfChannels; c++) {
            const d = audioBuffer.getChannelData(c);
            for (let i = 0; i < d.length; i++) {
              const a = Math.abs(d[i]); 
              if (a > peak) peak = a;
              // Check for sudden sample-to-sample jumps (drum transients)
              if (i > 0) {
                const change = Math.abs(d[i] - d[i-1]);
                if (change > maxChange) maxChange = change;
              }
            }
          }
          
          // Limit based on peak OR sudden changes
          let needsLimiting = false;
          let scale = 1.0;
          
          if (peak > 0.8) {
            needsLimiting = true;
            scale = Math.min(scale, 0.8 / peak);
          }
          
          // If there are sudden jumps (drums/bass), be extra aggressive
          if (maxChange > 0.3) {
            needsLimiting = true;
            scale = Math.min(scale, 0.6); // Very conservative for transients
          }
          
          if (needsLimiting) {
            for (let c = 0; c < audioBuffer.numberOfChannels; c++) {
              const d = audioBuffer.getChannelData(c);
              for (let i = 0; i < d.length; i++) d[i] *= scale;
            }
          }
          // Store tails
          this.lastTailSamples = [];
          const tailKeep = Math.max(cfSamples, 96);
          for (let c = 0; c < audioBuffer.numberOfChannels; c++) {
            const d = audioBuffer.getChannelData(c);
            const keep = Math.min(tailKeep, d.length);
            const tail = new Float32Array(keep);
            tail.set(d.subarray(d.length - keep));
            this.lastTailSamples[c] = tail;
          }
        } catch (_) { }
        try { src.start(startAt); } catch (e) { try { src.start(); } catch (_) { } }
        // maintain nextPlayTime for UI backward compatibility
        this.nextPlayTime = startAt + audioBuffer.duration;

        src.onended = () => { try { this.activeSources.delete(src); } catch (_) { } };

        this.activeSources.add(src);

        // allow event loop to breathe (no visible jitter)
        await new Promise(r => setTimeout(r, 0));
      } catch (e) {
        console.warn('processAudioQueue error', e);
      }
    }

    this.isProcessingQueue = false;
    this.updatePlaybackStatus();
  }

  // ---------------- DEVICE UI (compact rows) ----------------
  updateDeviceList(devices) {
    const listEl = document.getElementById('deviceList');
    const countEl = document.getElementById('onlineDeviceCount');
    if (!listEl) return;
    // Preserve current listening source to restore button labels without user-visible flicker
    const currentListening = this.listeningToSource;
    listEl.innerHTML = '';
    let online = 0;
    devices.forEach(d => {
      const row = document.createElement('div');
      row.className = 'd-flex align-items-center justify-content-between py-2 border-bottom';
      const left = document.createElement('div');
      left.innerHTML = `<div class="fw-semibold">${d.name || d.id}</div><div class="text-muted small">${d.ip || ''}</div>`;
      const right = document.createElement('div');

      if (d.isStreaming) {
        online++;
        const btn = document.createElement('button');
        btn.className = 'btn btn-sm btn-outline-primary';
        btn.innerHTML = (currentListening === d.id && this.isListening) ? 'Stop' : '<i class="bi bi-headphones me-1"></i>Listen';
        btn.dataset.id = d.id;
        btn.addEventListener('click', () => {
          if (this.isListening && this.listeningToSource === d.id) {
            this.stopListening();
            btn.innerHTML = '<i class="bi bi-headphones me-1"></i>Listen';
          } else {
            this.startListening(d.id);
            btn.innerHTML = 'Stop';
          }
        });
        right.appendChild(btn);
      } else {
        const disabled = document.createElement('button');
        disabled.className = 'btn btn-sm btn-secondary';
        disabled.disabled = true;
        disabled.textContent = 'Not streaming';
        right.appendChild(disabled);
      }

      row.appendChild(left);
      row.appendChild(right);
      listEl.appendChild(row);
    });
    if (countEl) countEl.textContent = `${online} online`;
  }

  markDeviceButtonListening(deviceId, listening) {
    const listEl = document.getElementById('deviceList');
    if (!listEl) return;
    listEl.querySelectorAll('button').forEach(b => {
      if (b.dataset.id === deviceId) {
        b.innerHTML = listening ? 'Stop' : '<i class="bi bi-headphones me-1"></i>Listen';
      }
    });
  }

  connectToDevice(deviceId) { this.startListening(deviceId); }

  updateListeningUI(sourceName) {
    let listenStatus = document.getElementById('listenStatus');
    if (!listenStatus) {
      const playCard = document.querySelector('#play .card-body') || document.body;
      const html = `
        <div class="alert alert-info mb-3" id="listenStatus">
          LISTENING TO: <strong id="listenSourceName">${sourceName}</strong>
          <button class="btn btn-sm btn-outline-info float-end" id="stopListenBtn">Stop</button>
          <div class="mt-2">Packets received: <span id="packetCount">0</span></div>
        </div>`;
      playCard.insertAdjacentHTML('afterbegin', html);
      document.getElementById('stopListenBtn').addEventListener('click', () => this.stopListening());
    } else {
      const nameEl = document.getElementById('listenSourceName');
      if (nameEl) nameEl.textContent = sourceName;
      listenStatus.classList.remove('d-none');
    }
    const serverStatus = document.getElementById('serverStatus');
    if (serverStatus) { serverStatus.textContent = 'LISTENING'; serverStatus.className = 'badge bg-info'; }
  }

  manualConnect() {
    const manualIP = document.getElementById('manualIP')?.value?.trim();
    if (!manualIP) { this.showToast('Enter IP:PORT', 'warning'); return; }
    const [ip, port] = manualIP.split(':');
    this.socket.emit('manualConnect', { ip, port: port ? parseInt(port) : 3001 });
  }

  filterDevices(q) {
    const query = (q || '').trim().toLowerCase();
    document.querySelectorAll('#deviceList > div').forEach(card => {
      const txt = card.textContent.toLowerCase();
      card.style.display = txt.includes(query) ? '' : 'none';
    });
  }

  async getDeviceName() {
    try {
      const ua = navigator.userAgent || '';
      if (ua.includes('Windows')) return 'Windows PC';
      if (ua.includes('Mac')) return 'Mac';
      if (ua.includes('Linux')) return 'Linux';
      if (/Android/.test(ua)) return 'Android';
      if (/iPhone|iPad/.test(ua)) return 'iOS';
    } catch { }
    return 'Unknown Device';
  }

  showToast(message, type = 'info') {
    const container = document.getElementById('toastContainer');
    if (!container) { console.log(`${type.toUpperCase()}:`, message); return; }
    const id = 't' + Date.now();
    const bg = type === 'error' ? 'bg-danger' : type === 'success' ? 'bg-success' : type === 'warning' ? 'bg-warning text-dark' : 'bg-info';
    // Determine appropriate text color if not explicitly set
    const forceDark = bg.includes('bg-warning');
    const textClass = forceDark ? '' : 'text-white';
    const closeClass = forceDark ? '' : 'btn-close-white';
    const html = `<div id="${id}" class="toast ${bg} ${textClass} align-items-center" role="alert" aria-live="assertive" aria-atomic="true" style="min-width:200px; margin-bottom:6px; box-shadow:0 2px 6px rgba(0,0,0,0.35);"><div class="d-flex"><div class="toast-body" style="white-space:normal; word-break:break-word;">${message}</div><button type="button" class="btn-close ${closeClass} me-2 m-auto" data-bs-dismiss="toast"></button></div></div>`;
    container.insertAdjacentHTML('beforeend', html);
    const el = document.getElementById(id);
    try {
      const bsToast = new bootstrap.Toast(el, { delay: 4000 });
      bsToast.show();
      el.addEventListener('hidden.bs.toast', () => el.remove());
    } catch {
      setTimeout(() => el.remove(), 4000);
    }
  }
}

window.app = new AudioTransferApp();
