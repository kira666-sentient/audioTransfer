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
  }

  initSocket() {
    if (this.socket) return;
    this.socket = io();

    this.socket.on('connect', () => {
      const s = document.getElementById('serverStatus');
      if (s && !this.isStreaming && !this.isListening) { s.textContent = 'ONLINE'; s.className = 'badge bg-success'; }
      this.socket.emit('discoverDevices');
    });

    this.socket.on('disconnect', () => {
      const s = document.getElementById('serverStatus');
      if (s) { s.textContent = 'OFFLINE'; s.className = 'badge bg-secondary'; }
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
        if (this.isListening && this.listeningToSource === streamData.sourceId) {
          this.playAudioData(streamData);
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
      return await navigator.mediaDevices.getUserMedia({
        audio: {
          sampleRate: settings.sampleRate,
          channelCount: settings.channelCount,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: false // disable AGC for best fidelity
        }
      });
    }
    if (source === 'system') {
      const stream = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: true });
      stream.getVideoTracks().forEach(t => t.stop());
      if (!stream.getAudioTracks().length) { stream.getTracks().forEach(t => t.stop()); throw new Error('System audio unavailable'); }
      return stream;
    }
    throw new Error('Unknown source');
  }

  async startStreaming() {
    try {
      const startBtn = document.getElementById('startStreamBtn');
      const stopBtn = document.getElementById('stopStreamBtn');
      const liveIndicator = document.getElementById('liveIndicator');
      const serverStatus = document.getElementById('serverStatus');

      if (startBtn) { startBtn.disabled = true; startBtn.innerHTML = 'Starting...'; }

      const source = (document.querySelector('input[name="audioSource"]:checked') || {}).value || 'microphone';
      const quality = (document.querySelector('input[name="quality"]:checked') || {}).value || 'high';

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
      if (this.captureSourceNode) { try { this.captureSourceNode.disconnect(); } catch (_) {} this.captureSourceNode = null; }
      if (this.workletNode) { try { this.workletNode.disconnect(); } catch (_) {} this.workletNode = null; }
      if (this.processorNode) { try { this.processorNode.disconnect(); } catch (_) {} this.processorNode = null; }
      if (this.silentGainNode) { try { this.silentGainNode.disconnect(); } catch (_) {} this.silentGainNode = null; }
      if (this.captureContext && this.captureContext.state !== 'closed') { try { await this.captureContext.close(); } catch (_) {} }
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
    if (!this.audioContext) this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
    if (this.audioContext.state === 'suspended') await this.audioContext.resume();

    // unlock audio with a tiny silent tick (cheap)
    try {
      const g = this.audioContext.createGain(); g.gain.value = 0.0001;
      const osc = this.audioContext.createOscillator();
      osc.connect(g).connect(this.audioContext.destination);
      osc.start(); osc.stop(this.audioContext.currentTime + 0.01);
    } catch (_) {}

    this.setupAudioPlayback();
    this.listeningToSource = sourceId;
    this.isListening = true;
    this.packetCount = 0;

    if (this.socket) this.socket.emit('joinAsListener', sourceId);
    this.showToast('Joining as listener...', 'info');

    // mark button without full device list refresh
    this.markDeviceButtonListening(sourceId, true);
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
    for (const s of Array.from(this.activeSources)) { try { s.stop(0); s.disconnect(); } catch (_) {} }
    this.activeSources.clear();

    if (prev) this.markDeviceButtonListening(prev, false);

    const serverStatus = document.getElementById('serverStatus');
    if (serverStatus) { serverStatus.textContent = this.isStreaming ? 'LIVE' : 'ONLINE'; serverStatus.className = this.isStreaming ? 'badge bg-success' : 'badge bg-secondary'; }
    this.showToast('Stopped listening', 'info');
  }

  setupAudioPlayback() {
    if (!this.audioContext) return;
    if (!this.playbackGain) {
      this.playbackGain = this.audioContext.createGain();
      this.playbackGain.gain.value = 1.0;
      this.playbackGain.connect(this.audioContext.destination);
    }
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

        src.connect(this.playbackGain);

        const now = this.audioContext.currentTime;
        if (!this.nextPlayTime || this.nextPlayTime < now) this.nextPlayTime = now + this.fixedLatency;

        const startAt = this.nextPlayTime;
        try { src.start(startAt); } catch (e) { try { src.start(); } catch (_) {} }
        this.nextPlayTime = startAt + audioBuffer.duration;

        src.onended = () => { try { this.activeSources.delete(src); } catch (_) {} };

        this.activeSources.add(src);

        // allow event loop to breathe (no visible jitter)
        await new Promise(r => setTimeout(r, 0));
      } catch (e) {
        console.warn('processAudioQueue error', e);
      }
    }

    this.isProcessingQueue = false;
  }

  // ---------------- DEVICE UI (compact rows) ----------------
  updateDeviceList(devices) {
    const listEl = document.getElementById('deviceList');
    const countEl = document.getElementById('onlineDeviceCount');
    if (!listEl) return;
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
        btn.innerHTML = '<i class="bi bi-headphones me-1"></i>Listen';
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
      if (b.dataset.id === deviceId) b.textContent = listening ? 'Stop' : 'Listen';
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
    } catch {}
    return 'Unknown Device';
  }

  showToast(message, type = 'info') {
    const container = document.getElementById('toastContainer');
    if (!container) { console.log(`${type.toUpperCase()}:`, message); return; }
    const id = 't' + Date.now();
    const bg = type === 'error' ? 'bg-danger' : type === 'success' ? 'bg-success' : type === 'warning' ? 'bg-warning' : 'bg-info';
    const html = `<div id="${id}" class="toast ${bg} text-white align-items-center" role="alert" aria-live="assertive" aria-atomic="true" style="min-width:200px; margin-bottom:6px;"><div class="d-flex"><div class="toast-body">${message}</div><button type="button" class="btn-close btn-close-white me-2 m-auto" data-bs-dismiss="toast"></button></div></div>`;
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
