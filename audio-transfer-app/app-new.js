// app.js - Audio streaming with simplified pipeline (restored from old app approach)
// Goals implemented:
//  - Simple audioQueue array for packet buffering (like original app)
//  - ReliabilityManager with idle pruning + sequence wrap + throttled retransmission
//  - Fixed latency playback modes (ultra/low/stable) instead of adaptive jitter
//  - Central sample sanitation (NaN/Infinity clamp)
//  - AudioEnhancer (simplified: conditional fade in standard mode only)
//  - Pure reliable delivery mode (no enhancements) vs standard mode
//  - Maintains existing UI methods: startStreaming, stopStreaming, startListening, stopListening,
//    discoverDevices, manualConnect, showToast, etc.
//  - Sequence numbers use uint32 wrap-around (>>> 0)

/*
  SIMPLIFIED ARCHITECTURE
  -----------------------
  AudioTransferApp
    ├─ ReliabilityManager: tracks per-source packets out-of-order & retransmission ranges
    ├─ Simple audioQueue: array of audio packets with monotonic nextPlayTime scheduling
    ├─ AudioEnhancer: minimal conditional fade (only in standard mode)
    ├─ Capture pipeline: AudioWorklet (preferred) or ScriptProcessor fallback
    ├─ Playback pipeline: Process audioQueue, schedule sources, apply EQ / compressor

  Threading model: all single-thread JS main; Worklet posts ArrayBuffers back.
*/

class SampleUtils {
  static sanitizeInterleaved(f32) {
    let changed = false;
    for (let i = 0; i < f32.length; i++) {
      let v = f32[i];
      if (!Number.isFinite(v) || Math.abs(v) > 8) { // extreme corruption
        v = 0; changed = true;
      }
      // hard clip to [-1,1]
      if (v > 1) { v = 1; changed = true; }
      else if (v < -1) { v = -1; changed = true; }
      f32[i] = v;
    }
    return changed;
  }

  static deInterleave(interleaved, channels) {
    const frames = Math.floor(interleaved.length / channels);
    const out = [];
    for (let c = 0; c < channels; c++) {
      const ch = new Float32Array(frames);
      for (let i = 0, k = c; i < frames; i++, k += channels) ch[i] = interleaved[k];
      out.push(ch);
    }
    return out;
  }

  static interleave(chArrays) {
    if (!chArrays.length) return new Float32Array();
    const frames = chArrays[0].length;
    const channels = chArrays.length;
    const out = new Float32Array(frames * channels);
    for (let c = 0; c < channels; c++) {
      const src = chArrays[c];
      for (let i = 0, k = c; i < frames; i++, k += channels) out[k] = src[i];
    }
    return out;
  }
}

class AudioEnhancer {
  constructor() {
    this.lastTail = null; // Float32Array[] per channel
  }

  apply(interleaved, channels, sampleRate, config) {
    // config: { enable, transientDetection, crossfadeMs, minFadeMs, maxFadeMs }
    if (!config.enable) return interleaved;

    // Transient dual-threshold aggressive smoothing
    if (config.transientDetection) {
      const frames = Math.floor(interleaved.length / channels);
      for (let c = 0; c < channels; c++) {
        let last = 0;
        for (let i = 0; i < frames; i++) {
          const idx = i * channels + c;
          const s = interleaved[idx];
          const delta = Math.abs(s - last);
          // aggressive thresholds (fine tuned by user):
            // hard clip threshold >0.9, smoothing band 0.18 - 0.9
          if (delta > 0.9) {
            // hard limit with blend to reduce click
            const limited = Math.sign(s) * 0.85;
            interleaved[idx] = last * 0.25 + limited * 0.75;
          } else if (delta > 0.18) {
            // moderate smoothing preserving edge definition
            interleaved[idx] = last * 0.35 + s * 0.65;
          }
          last = interleaved[idx];
        }
      }
    }

    // Conditional fade-in / overlap-add crossfade based on previous tail
    if (config.crossfadeMs && this.lastTail) {
      const frames = Math.floor(interleaved.length / channels);
      const crossfadeSamples = Math.min(
        Math.floor(sampleRate * (config.crossfadeMs / 1000)),
        Math.floor(frames / 3)
      );
      if (crossfadeSamples > 8) {
        const current = SampleUtils.deInterleave(interleaved, channels);
        for (let c = 0; c < channels; c++) {
          const prev = this.lastTail[c];
          if (!prev) continue;
          const ov = Math.min(crossfadeSamples, prev.length, current[c].length);
          let corrupted = false;
          for (let i = 0; i < ov; i++) {
            const v = prev[prev.length - ov + i];
            if (!Number.isFinite(v) || Math.abs(v) > 1) { corrupted = true; break; }
          }
          if (corrupted) continue;
          for (let i = 0; i < ov; i++) {
            const w = 0.5 * (1 - Math.cos(Math.PI * i / (ov - 1 || 1))); // Hann
            const prevW = 1 - w;
            current[c][i] = prev[prev.length - ov + i] * prevW + current[c][i] * w;
          }
        }
        // re-interleave
        interleaved = SampleUtils.interleave(current);
      }
    } else if (config.fadeInMs) {
      const frames = Math.floor(interleaved.length / channels);
      const fadeSamples = Math.min(
        Math.max(16, Math.floor(sampleRate * (config.fadeInMs / 1000))),
        Math.floor(frames / 4)
      );
      if (fadeSamples > 0) {
        for (let i = 0; i < fadeSamples; i++) {
          const w = 0.5 * (1 - Math.cos(Math.PI * i / (fadeSamples - 1 || 1)));
          for (let c = 0; c < channels; c++) {
            const idx = i * channels + c;
            interleaved[idx] *= w;
          }
        }
      }
    }

    // Update tail store
    const tailKeepMs = 2.0; // short tail
    const sampleKeep = Math.min(
      Math.floor(sampleRate * (tailKeepMs / 1000)),
      Math.floor(interleaved.length / channels)
    );
    const frames = Math.floor(interleaved.length / channels);
    const start = Math.max(0, frames - sampleKeep);
    const deInt = SampleUtils.deInterleave(interleaved, channels);
    this.lastTail = deInt.map(ch => ch.slice(start));

    return interleaved;
  }

  reset() { this.lastTail = null; }
}

class ReliabilityManager {
  constructor(options = {}) {
    this.sources = new Map(); // sourceId -> {expected, packets: Map(seq, pkt), lastActivity, requestTimer}
    this.maxPacketsPerSource = options.maxPacketsPerSource || 400;
    this.idleMs = options.idleMs || 15000;
    this.retransmissionTimeout = options.retransmissionTimeout || 90; // ms
    this.lastRetransmissionRequest = new Map(); // key => timestamp
    this.missingFirstSeen = new Map(); // sourceId -> {seq, firstSeen}
  }

  _get(sourceId, initialSeq) {
    if (!this.sources.has(sourceId)) {
      this.sources.set(sourceId, {
        expected: typeof initialSeq === 'number' ? initialSeq : 0,
        packets: new Map(),
        lastActivity: performance.now(),
        requestTimer: null
      });
    }
    return this.sources.get(sourceId);
  }

  add(packet, emitRetransmitCb) {
    const { sourceId, seq } = packet;
    if (typeof seq !== 'number') return [];
    const st = this._get(sourceId, seq);
    st.lastActivity = performance.now();
    // store (overwrite safe)
    st.packets.set(seq >>> 0, packet);
    // prune old packets by sequence age (before size-based pruning)
    const windowSize = 200; // packets older than this behind expected are dropped
    const minAllowed = (st.expected - windowSize) >>> 0;
    for (const [seq] of st.packets.entries()) {
      // Handle wrap-around: if seq is way ahead, it's actually old
      const seqDist = (seq - st.expected) >>> 0;
      if (seqDist > 0x80000000) { // more than half the uint32 space = old packet
        st.packets.delete(seq);
      }
    }
    
    // prune size
    if (st.packets.size > this.maxPacketsPerSource) {
      // delete lowest sequences first
      const keys = Array.from(st.packets.keys()).sort((a, b) => a - b);
      const excess = st.packets.size - this.maxPacketsPerSource;
      for (let i = 0; i < excess; i++) st.packets.delete(keys[i]);
    }

    const ready = [];
    // consume in-order - removed arbitrary guard limit
    let processed = 0;
    while (st.packets.has(st.expected >>> 0)) {
      const p = st.packets.get(st.expected >>> 0);
      st.packets.delete(st.expected >>> 0);
      ready.push(p);
      st.expected = (st.expected + 1) >>> 0;
      // Safety break for runaway loops (much higher than 32)
      if (++processed > this.maxPacketsPerSource) break;
    }

    // If a previously tracked gap has been fully healed by arrivals, clear its record
    const gapMeta = this.missingFirstSeen.get(sourceId);
    if (gapMeta && (gapMeta.seq + 1) <= st.expected) {
      this.missingFirstSeen.delete(sourceId);
    }

    // gap detection (simple future seq)
    if ((seq >>> 0) > (st.expected >>> 0)) {
      if (!st.requestTimer) {
        st.requestTimer = setTimeout(() => {
          // still missing? request range
          const start = st.expected >>> 0;
          const end = ((seq - 1) >>> 0);
          const key = `${sourceId}-${start}-${end}`;
          const now = performance.now();
          const last = this.lastRetransmissionRequest.get(key) || 0;
          if (now - last > this.retransmissionTimeout) {
            this.lastRetransmissionRequest.set(key, now);
            emitRetransmitCb(sourceId, start, end);
          }
          st.requestTimer = null;
        }, this.retransmissionTimeout);
      }
      if (!this.missingFirstSeen.has(sourceId)) {
        this.missingFirstSeen.set(sourceId, { seq: st.expected >>> 0, firstSeen: performance.now() });
      }
    }

    return ready;
  }

  pruneIdle() {
    const now = performance.now();
    for (const [id, st] of this.sources.entries()) {
      if (now - st.lastActivity > this.idleMs) this.sources.delete(id);
    }
  }

  resetSource(id) { 
    const st = this.sources.get(id);
    if (st && st.requestTimer) {
      clearTimeout(st.requestTimer);
      st.requestTimer = null;
    }
    this.sources.delete(id); 
  }
  resetAll() { 
    // Clear all pending timers before clearing sources
    for (const st of this.sources.values()) {
      if (st.requestTimer) {
        clearTimeout(st.requestTimer);
      }
    }
    this.sources.clear(); 
  }

  getGapInfo(sourceId) { return this.missingFirstSeen.get(sourceId) || null; }
  skipGap(sourceId, upToSeq) {
    const st = this.sources.get(sourceId);
    if (!st) return false;
    if (upToSeq <= st.expected) return false;
    for (let s = st.expected; s < upToSeq; s = (s + 1) >>> 0) {
      st.packets.delete(s >>> 0);
    }
    st.expected = upToSeq >>> 0;
    this.missingFirstSeen.delete(sourceId);
    return true;
  }
}

// JitterBuffer class removed - now using simple audioQueue array approach like old app

class AudioTransferApp {
  constructor() {
    // Network/socket
    this.socket = null;

    // Capture
    this.captureContext = null;
    this.captureSourceNode = null;
    this.workletNode = null;
    this.processorNode = null;
    this.silentGainNode = null;
    this.mediaStream = null;
    this._sendSeq = 0 >>> 0;

    // Playback
    this.audioContext = null;
    this.playbackGain = null;
    this.eqNodes = {};
    this.compressorNode = null;
    this.activeSources = new Set(); // Track active audio sources

    // Simple audio queue and scheduling (like old app)
    this.audioQueue = [];
    this.isProcessingQueue = false;
    this.nextPlayTime = 0;
    this.activeSources = new Set();
    this.fadeTime = 0.0008; // 0.8ms conditional fade-in
    this.underruns = 0;
    this.lastTailSamples = null;
    // Monotonic playback scheduler from old app
    this.playCursorSamples = 0;
    this._anchorTime = 0;
    this.lastSequenceMap = {}; // track seq per source for gap detection
    this.fixedLatency = 0.12; // default latency

    // State
    this.isStreaming = false;
    this.isListening = false;
    this.listeningToSource = null;
    this.packetCount = 0;

    // Simple feature toggles (like old app)
    this.features = {
      reliableDelivery: true, // Pure reliable delivery like old app
      seqGapSilenceInsert: true, // insert silence on gaps
      conditionalFade: true // minimal fade-in only
    };
    // Simple crossfade config (like old app)
    this.minCrossfadeMs = 0.8;
    this.maxCrossfadeMs = 2.5;
    this.crossfadeMs = 0.002;

    // Simple metrics (like old app)
    this.metrics = { 
      underruns: 0,
      packetsReceived: 0,
      packetsPlayed: 0
    };

    // Debug control
    this.debugPanelVisible = false;

  // Listener count cache (server-sent aggregate)
  this.listenerCounts = {}; // sourceId -> count
  this._lastDevices = [];   // last device list for re-render with counts

    document.addEventListener('DOMContentLoaded', () => this.init());
    window.addEventListener('beforeunload', () => this.cleanup());

    // Structured logging ring buffer (disabled by default)
    this._logs = [];
    this._logLimit = 400;
    this._loggingEnabled = false;

    // Initialize missing components
    this.reliableManager = new ReliabilityManager({
      maxPacketsPerSource: 400,
      idleMs: 15000,
      retransmissionTimeout: 100
    });
    this.enhancer = new AudioEnhancer();
  // Removed reliableBuffer: now using ReliabilityManager exclusively
    // Using ReliabilityManager's settings for retransmission
    this.lastProcessedPackets = new Map(); // Prevent duplicate packet processing
  }

  /* ---------------- Initialization & Socket ---------------- */
  init() {
    this.initSocket();
    this.setupEventListeners();
    this.detectLocalIP();
    this._restoreUserSettings && this._restoreUserSettings();
  }

  initSocket() {
    if (this.socket) return;
    this.socket = io({ transports: ['websocket', 'polling'] });

    this.socket.on('connect', () => {
      this.updateServerStatus('ONLINE', 'bg-success');
      this.showToast('Connected', 'success');
      this.discoverDevices();
      this._updateStreamingUI && this._updateStreamingUI();
      this._updatePlaybackStatus('Idle');
    });
    this.socket.on('disconnect', () => {
      this.updateServerStatus('OFFLINE', 'bg-secondary');
      this._updateStreamingUI && this._updateStreamingUI();
      this._updatePlaybackStatus && this._updatePlaybackStatus('Disconnected');
    });
    this.socket.on('deviceList', d => this.updateDeviceList(d));
    this.socket.on('streamStarted', () => this.discoverDevices());
    this.socket.on('streamStopped', info => {
      this.discoverDevices();
      if (this.listeningToSource === info.clientId) this.stopListening();
      // Prune reliability state
      if (this.reliableManager && info.clientId) {
        this.reliableManager.resetSource(info.clientId);
      }
      if (info && info.clientId) this._updatePlaybackStatus('Source stopped');
    });

    // Aggregate listener counts (sourceId -> number of listeners)
    this.socket.on('listenerCounts', counts => {
      if (!counts || typeof counts !== 'object') return;
      this.listenerCounts = counts;
      // re-render with cached device list if present
      if (this._lastDevices.length) this.updateDeviceList(this._lastDevices);
      this._updateStreamingUI && this._updateStreamingUI();
    });

    // Core audio packet event - use old app's simple reliable delivery
    this.socket.on('audioStream', streamData => {
      if (!this.isListening || !streamData) return;
      
      // Prevent double processing - important for avoiding audio issues
      const now = Date.now();
      const key = `${streamData.sourceId}-${streamData.seq}`;
      if (this.lastProcessedPackets && this.lastProcessedPackets.has(key)) {
        const lastTime = this.lastProcessedPackets.get(key);
        if (now - lastTime < 100) { // Within 100ms = duplicate
          return;
        }
      }
      
      if (!this.lastProcessedPackets) {
        this.lastProcessedPackets = new Map();
      }
      this.lastProcessedPackets.set(key, now);
      
      // Clean up old entries periodically
      if (this.lastProcessedPackets.size > 1000) {
        const cutoff = now - 5000; // Keep 5 seconds
        for (const [k, time] of this.lastProcessedPackets.entries()) {
          if (time < cutoff) {
            this.lastProcessedPackets.delete(k);
          }
        }
      }
      
      if (this.features.reliableDelivery) {
        this.handleReliableDelivery(streamData);
      } else {
        this.playAudioData(streamData);
      }
    });

    this.socket.on('retransmittedPackets', packets => {
      if (!this.features.reliableDelivery) return;
      packets.forEach(packet => this.handleReliableDelivery(packet));
    });

    this.socket.on('clientDisconnected', info => {
      // If we were listening to this source, stop
      if (info && info.id && this.listeningToSource === info.id) {
        this.stopListening();
        this._updatePlaybackStatus('Source disconnected');
      }
      this.discoverDevices();
    });

    this.socket.on('rateLimitWarning', () => {
      this.showToast('Sender over packet rate limit', 'warning');
    });

    this.socket.on('streamingStarted', (response) => {
      if (!response.success) {
        console.error('Streaming failed to start:', response.message);
        this.showToast('Failed to start streaming: ' + response.message, 'error');
        this.isStreaming = false;
        this._updateStreamingUI && this._updateStreamingUI();
      } else {
        console.log('Streaming confirmed by server:', response.message);
      }
    });

    this.socket.on('joinedAsListener', info => {
      if (info && info.sourceName) this._updatePlaybackStatus(`Listening: ${info.sourceName}`);
    });

    this.socket.on('listenerJoined', ev => {
      // Optional: could display toast
      if (this.isStreaming) this._updateStreamingUI();
    });

    this.socket.on('listenerLeft', ev => {
      if (this.isStreaming) this._updateStreamingUI();
    });
  }

  updateServerStatus(text, cls) {
    const el = document.getElementById('serverStatus');
    if (el) { el.textContent = text; el.className = `badge ${cls}`; }
  }

  _updatePlaybackStatus(status) {
    // Update playback status in UI if element exists
    const el = document.getElementById('playbackStatus');
    if (el) el.textContent = status;
    console.log('Playback status:', status);
  }

  /* ---------------- Event Handlers ---------------- */
  setupEventListeners() {
    // Remove any existing event listeners to prevent duplicates
    const elements = [
      'startStreamBtn', 'stopStreamBtn', 'refreshDevices', 'reliableDelivery',
      'playbackVolume', 'loudnessBoost', 'eqPreset', 'modeLowLat', 'modeUltraLow',
      'modeHighStab', 'naturalBypass', 'resetSync', 'manualConnect', 'deviceSearch',
      'logToggle', 'downloadLogs'
    ];
    
    elements.forEach(id => {
      const el = document.getElementById(id);
      if (el) {
        // Clone the element to remove all event listeners
        const newEl = el.cloneNode(true);
        el.parentNode.replaceChild(newEl, el);
      }
    });
    
    // Now add fresh event listeners
    console.log('Setting up event listeners...');
    document.getElementById('startStreamBtn')?.addEventListener('click', () => {
      console.log('Start stream button clicked!');
      this.startStreaming();
    });
    document.getElementById('stopStreamBtn')?.addEventListener('click', () => this.stopStreaming());
    document.getElementById('refreshDevices')?.addEventListener('click', () => this.discoverDevices());

    // Reliable toggle (maintain UI expectation) - Fixed implementation
    document.getElementById('reliableDelivery')?.addEventListener('change', e => {
      try {
        // Store previous state for rollback if needed
        const previousState = this.features.reliableDelivery;
        
        // Validate audio context exists (only when enabling)
        if (e.target.checked && !this.audioContext) {
          this.showToast('Cannot enable reliable delivery: audio context not initialized', 'error');
          e.target.checked = false;
          return;
        }

        // Attempt to change state
        this.features.reliableDelivery = !!e.target.checked;
        
        // CRITICAL: Proper cleanup and reset
        try {
          // Stop all active audio sources
          for (const source of this.activeSources || []) {
            try { source.stop(0); } catch(_) {}
          }
          this.activeSources.clear();
          
          // Clear reliable buffers and reset state
          // reliableBuffer.clear() removed
          this.audioQueue = []; // Clear audio queue
          this.nextPlayTime = 0;
          this.lastScheduleTime = 0;
          this.lastPlayedTimestamp = 0;
          this.lastTailSamples = null;
          this.playCursorSamples = 0;
          this._anchorTime = 0;
          
          // Reset audio context timing if available
          if (this.audioContext && this.audioContext.state === 'running') {
            // Force a small delay to let audio context settle
            setTimeout(() => {
              this.nextPlayTime = this.audioContext.currentTime + this.fixedLatency;
            }, 50);
          }
          
          // Reset enhancement state
          this._updateEnhancementEnablement();
          
        } catch (stateError) {
          console.warn('Error clearing reliable delivery state:', stateError);
          // Reinitialize buffers if clearing failed
          // reliableBuffer = new Map() removed
          this.lastRetransmissionRequest = {};
        }
        
        // Update settings persistence
        this._persistUserSettings && this._persistUserSettings();
        
        if (this.features.reliableDelivery) {
          this.showToast('Pure Reliable Mode: TCP-like ordering, no audio enhancements, tighter latency', 'info');
        } else {
          this.showToast('Standard Mode: Enhancements enabled, adaptive processing', 'info');
        }
        
      } catch (error) {
        console.error('Error toggling reliable delivery:', error);
        this.showToast('Failed to toggle reliable delivery: ' + error.message, 'error');
        // Rollback the checkbox state
        e.target.checked = !e.target.checked;
      }
    });

    // Playback volume
    document.getElementById('playbackVolume')?.addEventListener('input', e => {
      const v = Math.min(200, Math.max(0, +e.target.value || 100));
      if (this.playbackGain) this.playbackGain.gain.value = v / 100;
    });

    // Loudness boost (simple compressor enable/disable)
    document.getElementById('loudnessBoost')?.addEventListener('change', e => {
      const enable = !!e.target.checked;
      if (!this.audioContext) return;
      if (enable && !this.compressorNode) {
        this.compressorNode = this.audioContext.createDynamicsCompressor();
        this.compressorNode.threshold.value = -24;
        this.compressorNode.knee.value = 20;
        this.compressorNode.ratio.value = 3;
        this.compressorNode.attack.value = 0.003;
        this.compressorNode.release.value = 0.25;
        this.setupAudioPlaybackChain();
      } else if (!enable && this.compressorNode) {
        try { this.compressorNode.disconnect(); } catch(_){}
        this.compressorNode = null;
        this.setupAudioPlaybackChain();
      }
    });

    // EQ preset
    document.getElementById('eqPreset')?.addEventListener('change', e => this._applyEqPreset(e.target.value));
    // Individual EQ sliders
    document.querySelectorAll('.eq-band').forEach(sl => {
      sl.addEventListener('input', ev => {
        const band = +ev.target.dataset.band;
        const val = +ev.target.value;
        if (this.eqNodes[band]) this.eqNodes[band].gain.value = val;
      });
    });

    // Playback modes
    document.getElementById('modeLowLat')?.addEventListener('change', e => { if (e.target.checked) this._setPlaybackMode('low'); });
    document.getElementById('modeUltraLow')?.addEventListener('change', e => { if (e.target.checked) this._setPlaybackMode('ultra'); });
    document.getElementById('modeHighStab')?.addEventListener('change', e => { if (e.target.checked) this._setPlaybackMode('stable'); });

    // Natural bypass
    document.getElementById('naturalBypass')?.addEventListener('change', e => {
      this._updateEnhancementEnablement();
      if (e.target.checked) {
        this.showToast('Natural bypass enabled - direct audio path', 'info');
      } else {
        this.showToast('Audio processing enabled', 'info');
      }
      this._persistUserSettings && this._persistUserSettings();
    });

    // Reset sync
    document.getElementById('resetSync')?.addEventListener('click', () => this._resetSync());

    // Manual connect placeholder
    document.getElementById('manualConnect')?.addEventListener('click', () => {
      const val = (document.getElementById('manualIP') || {}).value || '';
      this.showToast('Manual connect not implemented: ' + val, 'warning');
    });

    // Device search filter
    document.getElementById('deviceSearch')?.addEventListener('input', () => this._filterDeviceList());
    document.getElementById('logToggle')?.addEventListener('change', e => { this._loggingEnabled = !!e.target.checked; });
    document.getElementById('downloadLogs')?.addEventListener('click', () => this._downloadLogs && this._downloadLogs());
  }

  _updateEnhancementEnablement() {
    // Like old app: reliable delivery disables all enhancements for pure quality
    const naturalBypass = document.getElementById('naturalBypass')?.checked;
    this.features.enhancementsEnabled = !this.features.reliableDelivery && !naturalBypass;
    
    if (this.features.reliableDelivery) {
      // Pure reliable mode - no enhancements, direct audio path
      this.features.conditionalFade = false;
      this.features.transientDetection = false;
      this.features.overlapAdd = false;
      
      // Reset audio timing for clean switch
      this.resetAudioTiming();
      
      console.log('Reliable delivery mode: Pure audio path, no enhancements');
    } else {
      // Standard mode with enhancements like old app
      this.features.conditionalFade = true;
      this.features.transientDetection = true;
      this.features.overlapAdd = true;
      
      // Reset audio timing for clean switch
      this.resetAudioTiming();
      
      console.log('Standard mode: Audio enhancements enabled');
    }
  }

  discoverDevices() { if (this.socket) this.socket.emit('discoverDevices'); }

  /* ---------------- Capture / Streaming ---------------- */
  async getMediaStream(source, quality) {
    const q = {
      low: { sampleRate: 22050, channelCount: 1 },
      medium: { sampleRate: 44100, channelCount: 1 },
      high: { sampleRate: 44100, channelCount: 2 },
      ultra: { sampleRate: 48000, channelCount: 2 }
    };
    const settings = q[quality] || q.high;
    
    try {
      if (source === 'microphone') {
        return await navigator.mediaDevices.getUserMedia({ audio: { ...settings, echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
      }
      if (source === 'system') {
        const stream = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: true });
        stream.getVideoTracks().forEach(t => t.stop());
        if (!stream.getAudioTracks().length) throw new Error('System audio not selected. Please ensure you select "Share audio" when prompted.');
        return stream;
      }
      throw new Error('Unknown audio source: ' + source);
    } catch (error) {
      if (error.name === 'NotAllowedError') {
        throw new Error('Microphone access denied. Please allow microphone access and try again.');
      } else if (error.name === 'NotFoundError') {
        throw new Error('No microphone found. Please connect a microphone and try again.');
      } else if (error.name === 'NotSupportedError') {
        throw new Error('Audio capture not supported in this browser.');
      }
      throw error;
    }
  }

  async startStreaming() {
    console.log('startStreaming called, isStreaming:', this.isStreaming);
    if (this.isStreaming) return;
    try {
      console.log('Starting stream attempt...');
      this._log && this._log('stream_start_attempt');
      const source = (document.querySelector('input[name="audioSource"]:checked') || {}).value || 'microphone';
      const quality = (document.querySelector('input[name="quality"]:checked') || {}).value || 'high';
      console.log('Source:', source, 'Quality:', quality);
      if (source === 'file') {
        // Delegate to file streaming pipeline
        const file = await this._pickLocalFile();
        if (!file) { this.showToast('No file selected', 'warning'); return; }
        await this._startFileStreaming(file, quality);
        return;
      }
      console.log('Getting media stream...');
      this.mediaStream = await this.getMediaStream(source, quality);
      console.log('Media stream obtained:', this.mediaStream);
      this.captureContext = new (window.AudioContext || window.webkitAudioContext)();
      console.log('Audio context created:', this.captureContext);
      
      // Handle audio context suspension (required by browsers)
      if (this.captureContext.state === 'suspended') {
        await this.captureContext.resume();
        console.log('Capture audio context resumed');
      }
      this.captureSourceNode = this.captureContext.createMediaStreamSource(this.mediaStream);
      this.silentGainNode = this.captureContext.createGain();
      this.silentGainNode.gain.value = 0; // keep graph alive
      this.silentGainNode.connect(this.captureContext.destination);

      try {
        const url = this._buildWorklet();
        await this.captureContext.audioWorklet.addModule(url);
        this.workletNode = new AudioWorkletNode(this.captureContext, 'capture-wl');
        this.workletNode.port.onmessage = ev => this._emitCaptured(ev.data);
        this.captureSourceNode.connect(this.workletNode).connect(this.silentGainNode);
      } catch (err) {
        // fallback ScriptProcessor
        const buf = 2048;
        this.processorNode = this.captureContext.createScriptProcessor(buf, this.captureSourceNode.channelCount, this.captureSourceNode.channelCount);
        const framesPerPacket = Math.round(this.captureContext.sampleRate * 0.02);
        const pending = []; let pendingFrames = 0; const chCount = this.captureSourceNode.channelCount;
        this.processorNode.onaudioprocess = e => {
          if (!this.isStreaming) return;
          const frameLen = e.inputBuffer.length;
            // interleave
          const inter = new Float32Array(frameLen * chCount);
          for (let c = 0; c < chCount; c++) {
            const ch = e.inputBuffer.getChannelData(c);
            for (let i = 0; i < frameLen; i++) inter[i * chCount + c] = ch[i];
          }
          pending.push(inter); pendingFrames += frameLen;
          while (pendingFrames >= framesPerPacket) {
            const out = new Float32Array(framesPerPacket * chCount);
            let filled = 0;
            while (filled < framesPerPacket && pending.length) {
              const head = pending[0]; const headFrames = head.length / chCount; const need = framesPerPacket - filled;
              if (headFrames <= need) { out.set(head, filled * chCount); filled += headFrames; pending.shift(); }
              else { out.set(head.subarray(0, need * chCount), filled * chCount); pending[0] = head.subarray(need * chCount); filled += need; }
            }
            pendingFrames -= framesPerPacket;
            this._emitCaptured({ audioBuffer: out.buffer, sampleRate: this.captureContext.sampleRate, channels: chCount });
          }
        };
        this.captureSourceNode.connect(this.processorNode).connect(this.silentGainNode);
      }

      const deviceName = await this.getDeviceName();
      const dnEl = document.getElementById('deviceName'); if (dnEl) dnEl.textContent = deviceName;
      
      // Validate socket connection before emitting
      if (!this.socket) {
        throw new Error('No socket connection available');
      }
      if (!this.socket.connected) {
        throw new Error('Socket not connected to server');
      }
      
      console.log('Emitting startStreaming event to server...', { source, quality, deviceName });
      this.socket.emit('startStreaming', { source, quality, deviceName });
      
      // Wait a moment to ensure server processed the request
      await new Promise(resolve => setTimeout(resolve, 100));
      
      this.isStreaming = true;
      console.log('Streaming state updated to true');
      this.showToast('Streaming started', 'success');
      this._updateStreamingUI && this._updateStreamingUI();
      this._log && this._log('stream_started', { source, quality });
    } catch (e) {
      console.error('Error in startStreaming:', e);
      
      // Clean up on error to prevent stuck state
      this.isStreaming = false;
      if (this.mediaStream) {
        this.mediaStream.getTracks().forEach(t => t.stop());
        this.mediaStream = null;
      }
      
      // Clean up audio context and nodes
      [this.workletNode, this.processorNode, this.captureSourceNode, this.silentGainNode].forEach(n => {
        try { n && n.disconnect(); } catch (_) { }
      });
      
      if (this.captureContext && this.captureContext.state !== 'closed') {
        this.captureContext.close().catch(() => {});
      }
      
      this.captureContext = null;
      this.workletNode = null;
      this.processorNode = null;
      this.silentGainNode = null;
      this.captureSourceNode = null;
      
      this.showToast('Failed to start streaming: ' + e.message, 'error');
      this._updateStreamingUI && this._updateStreamingUI();
      this._log && this._log('stream_start_error', { message: e.message });
    }
  }

  _emitCaptured(d) {
    if (!this.socket || !this.socket.connected) return;
    const payload = {
      seq: (this._sendSeq = (this._sendSeq + 1) >>> 0),
      sampleRate: d.sampleRate,
      channels: d.channels,
      timestamp: Date.now(),
      data: d.audioBuffer
    };
    this.socket.emit('audioData', payload);
  }

  async stopStreaming() {
    if (!this.isStreaming) return;
    try {
      this._log && this._log('stream_stop');
      if (this.mediaStream) { this.mediaStream.getTracks().forEach(t => t.stop()); this.mediaStream = null; }
      [this.workletNode, this.processorNode, this.captureSourceNode, this.silentGainNode].forEach(n => { try { n && n.disconnect(); } catch (_) { } });
      if (this.captureContext && this.captureContext.state !== 'closed') { await this.captureContext.close().catch(() => {}); }
      this.captureContext = null; this.workletNode = null; this.processorNode = null; this.silentGainNode = null; this.captureSourceNode = null;
      this.socket.emit('stopStreaming');
      this.isStreaming = false;
  this.showToast('Streaming stopped', 'info');
  this._updateStreamingUI && this._updateStreamingUI();
    } catch (e) { console.warn('Stop streaming error', e); }
  }

  _buildWorklet() {
    const code = `class W extends AudioWorkletProcessor {\n constructor(){super();this.frames=Math.max(1,Math.round(sampleRate*0.02));this.pending=[];this.pendingFrames=0;}\n process(inputs){const i=inputs[0];if(!i||!i[0])return true;const chs=i.length;const len=i[0].length;const inter=new Float32Array(len*chs);for(let c=0;c<chs;c++){const ch=i[c];for(let k=0;k<len;k++)inter[k*chs+c]=ch[k];}this.pending.push(inter);this.pendingFrames+=len;while(this.pendingFrames>=this.frames){const out=new Float32Array(this.frames*chs);let filled=0;while(filled<this.frames&&this.pending.length){const h=this.pending[0];const hf=h.length/chs;const need=this.frames-filled;if(hf<=need){out.set(h,filled*chs);filled+=hf;this.pending.shift();}else{out.set(h.subarray(0,need*chs),filled*chs);this.pending[0]=h.subarray(need*chs);filled+=need;}}this.pendingFrames-=this.frames;this.port.postMessage({audioBuffer:out.buffer,sampleRate,channels:chs});}return true;} } registerProcessor('capture-wl', W);`;
    return URL.createObjectURL(new Blob([code], { type: 'application/javascript' }));
  }

  /* ---------------- Playback / Listening ---------------- */
  async startListening(sourceId) {
    if (this.isListening && this.listeningToSource === sourceId) return;
    try {
      this._log && this._log('listen_start_attempt', { sourceId });
      if (!this.audioContext) {
        this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
      }
      
      // Handle audio context suspension (common on mobile/Chrome)
      if (this.audioContext.state === 'suspended') {
        await this.audioContext.resume();
        console.log('Audio context resumed');
      }
      
      // Audio unlock with tiny silent beep
      try {
        const g = this.audioContext.createGain(); 
        g.gain.value = 0.0001;
        const osc = this.audioContext.createOscillator();
        osc.connect(g).connect(this.audioContext.destination);
        osc.start(); 
        osc.stop(this.audioContext.currentTime + 0.01);
      } catch (_) { }

      this.setupAudioPlaybackChain();
      this.listeningToSource = sourceId; 
      this.isListening = true;
      this.packetCount = 0; 
      // Clear reliable buffers
  // reliableBuffer.clear() removed
      this.audioQueue = []; // Clear audio queue
      this.nextPlayTime = 0; // Reset timing
      this.enhancer.reset();
      this._updateEnhancementEnablement();

      this.socket.emit('joinAsListener', sourceId);
      this._startScheduler();
      this.showToast('Listening...', 'info');
      this._updatePlaybackStatus('Listening');
      this._log && this._log('listen_started', { sourceId });
    } catch (e) { 
      this.showToast('Failed to start listening: ' + e.message, 'error'); 
    }
  }

  stopListening() {
    if (!this.isListening) return;
    this._log && this._log('listen_stop', { sourceId: this.listeningToSource });
    this.isListening = false;
    const stoppedSource = this.listeningToSource;
    this.listeningToSource = null;
    this.audioQueue = [];
    // Clear any pending state in ReliabilityManager for the stopped source
    if (this.reliableManager && stoppedSource) {
      this.reliableManager.resetSource(stoppedSource);
    }
    if (this.socket) this.socket.emit('leaveAsListener');
    this._stopScheduler();
    this.showToast('Stopped listening', 'info');
    this._updatePlaybackStatus('Idle');
  }

  setupAudioPlaybackChain() {
    if (!this.audioContext) return;
    
    // Create EQ nodes if they don't exist
    const eqBands = [60, 250, 1000, 4000, 12000];
    eqBands.forEach(f => {
      if (!this.eqNodes[f]) {
        const biq = this.audioContext.createBiquadFilter();
        if (f === 60) biq.type = 'lowshelf';
        else if (f === 12000) biq.type = 'highshelf';
        else { biq.type = 'peaking'; biq.Q.value = 1; }
        biq.frequency.value = f; biq.gain.value = 0; this.eqNodes[f] = biq;
      }
    });

    if (!this.playbackGain) { 
      this.playbackGain = this.audioContext.createGain(); 
      this.playbackGain.gain.value = 1; 
    }

    // Connect chain: 60->250->...->12000-> (optional compressor) -> gain -> dest
    let node = this.eqNodes[60];
    [250, 1000, 4000, 12000].forEach(f => { 
      try { node.disconnect(); } catch(_){}
      node.connect(this.eqNodes[f]); 
      node = this.eqNodes[f]; 
    });
    
    try { node.disconnect(); } catch(_){}
    if (this.compressorNode) { 
      node.connect(this.compressorNode); 
      try { this.compressorNode.disconnect(); } catch(_){}
      this.compressorNode.connect(this.playbackGain); 
    } else {
      node.connect(this.playbackGain);
    }
    
    try { this.playbackGain.disconnect(); } catch(_){}
    this.playbackGain.connect(this.audioContext.destination);
    
    // Initialize timing
    if (!this.lastScheduleTime) {
      this.lastScheduleTime = this.audioContext.currentTime + this.fixedLatency;
    }
  }

  resetPlaybackPipeline() {
    // Stop all active sources with proper cleanup
    if (this.activeSources) {
      for (const source of this.activeSources) {
        try { 
          source.stop(0); 
          source.disconnect();
        } catch(_) {}
      }
      this.activeSources.clear();
    }
    
    this.audioQueue = []; // Clear queue
    
    // Clear reliable buffers with proper error handling
    try {
      // reliableBuffer.clear() removed
    } catch (e) {
      console.warn('Error clearing reliable buffer:', e);
  // reliableBuffer = new Map() removed
    }
    
    // Reset timing variables
    this.lastScheduleTime = 0;
    this.lastPlayedTimestamp = 0;
    this.nextPlayTime = 0;
    this.playCursorSamples = 0;
    this._anchorTime = 0;
    this.lastTailSamples = null;
    
    // Reset enhancement state
    if (this.enhancer) {
      this.enhancer.reset();
    }
    
    console.log('Playback pipeline reset completed');
  }

  _startScheduler() {
    // Simple direct processing - no complex scheduler needed
    console.log('Audio processing ready');
  }

  _stopScheduler() { if (this.schedulerTimer) { clearTimeout(this.schedulerTimer); this.schedulerTimer = null; } }

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

        if (frames <= 0) {
          console.warn('Empty audio buffer in queue, skipping');
          continue;
        }

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
        } else if (this.playbackGain) {
          src.connect(this.playbackGain);
        } else {
          // Fallback: connect directly to destination if playbackGain is null
          src.connect(this.audioContext.destination);
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

        // Aggressive transient detection for modern production
        if (!this.features.reliableDelivery) {
          try {
            for (let c = 0; c < audioBuffer.numberOfChannels; c++) {
              const d = audioBuffer.getChannelData(c);
              let lastSample = 0;
              let transientCount = 0;
              
              for (let i = 0; i < d.length; i++) {
                const sample = d[i];
                const change = Math.abs(sample - lastSample);
                
                // More aggressive detection for modern production
                if (change > 0.2 || (i > 0 && change > 0.1 && Math.abs(d[i-1] - (i > 1 ? d[i-2] : 0)) > 0.1)) {
                  transientCount++;
                  // Softer limiting for transients
                  const targetMax = 0.7;
                  if (Math.abs(sample) > targetMax) {
                    d[i] = Math.sign(sample) * targetMax;
                  }
                  
                  // Smooth the transition more aggressively for modern tracks
                  if (i > 0 && change > 0.15) {
                    const blend = 0.3; // More aggressive blending
                    d[i] = lastSample * (1 - blend) + sample * blend;
                  }
                }
                
                lastSample = d[i];
              }
              
              if (transientCount > 10) {
                console.log(`Channel ${c}: ${transientCount} transients detected and smoothed`);
              }
            }
          } catch (e) {
            console.warn('Transient detection error:', e);
          }
        }

        try {
          // crossfade / smoothing
          const sr = audioBuffer.sampleRate;
          const frames = audioBuffer.length;
          // --- Minimal guarded crossfade & fade-in (reintroduced safely) ---
          const wantMs = Math.min(this.maxCrossfadeMs, Math.max(this.minCrossfadeMs, (frames / sr) * 1000 * 0.12));
          const overlapSamples = Math.min(Math.floor(sr * (wantMs / 1000)), Math.floor(frames / 3));
          if (this.features.conditionalFade && this.lastTailSamples && overlapSamples > 8) {
            for (let c = 0; c < audioBuffer.numberOfChannels; c++) {
              const d = audioBuffer.getChannelData(c);
              const prev = this.lastTailSamples[c];
              if (!prev) continue;
              const ov = Math.min(overlapSamples, prev.length, d.length);
              // Validate previous tail (avoid propagating corruption)
              let corrupt = false;
              for (let i = 0; i < ov; i++) { const v = prev[prev.length - ov + i]; if (!isFinite(v) || Math.abs(v) > 1) { corrupt = true; break; } }
              if (corrupt) continue;
              for (let i = 0; i < ov; i++) {
                const w = 0.5 * (1 - Math.cos(Math.PI * i / (ov - 1 || 1))); // Hann
                const prevW = 1 - w;
                d[i] = prev[prev.length - ov + i] * prevW + d[i] * w;
              }
            }
          } else if (this.features.conditionalFade) {
            // Gentle 0.6ms – 1.2ms fade-in depending on buffer length
            const fadeSamples = Math.min(Math.max(32, Math.floor(sr * 0.0006)), Math.floor(frames / 4));
            for (let c = 0; c < audioBuffer.numberOfChannels; c++) {
              const d = audioBuffer.getChannelData(c);
              for (let i = 0; i < fadeSamples; i++) {
                const w = 0.5 * (1 - Math.cos(Math.PI * i / (fadeSamples - 1 || 1)));
                d[i] *= w;
              }
            }
          }
          // Store new tails for next crossfade
          this.lastTailSamples = [];
          const keep = Math.min(overlapSamples * 2 || 128, frames);
          for (let c = 0; c < audioBuffer.numberOfChannels; c++) {
            const d = audioBuffer.getChannelData(c);
            const tail = new Float32Array(keep);
            tail.set(d.subarray(d.length - keep));
            this.lastTailSamples[c] = tail;
          }
          // --- end minimal crossfade block ---
        } catch (_) { }
        
        try { src.start(startAt); } catch (e) { try { src.start(); } catch (_) { } }
        // maintain nextPlayTime for UI backward compatibility
        this.nextPlayTime = startAt + audioBuffer.duration;
        this.metrics.packetsPlayed++;

        src.onended = () => { try { this.activeSources.delete(src); } catch (_) { } };
        this.activeSources.add(src);

        // allow event loop to breathe (no visible jitter)
        await new Promise(r => setTimeout(r, 0));
      } catch (e) {
        console.warn('processAudioQueue error', e);
      }
    }

    this.isProcessingQueue = false;
  }



  /* ---------------- Audio Pipeline (from old app) ---------------- */
  
  // Reliable delivery: TCP-like packet ordering and retransmission
  handleReliableDelivery(streamData) {
    // Safety check: only process if reliable delivery is enabled
    if (!this.features.reliableDelivery) {
      console.warn('handleReliableDelivery called but reliable delivery is disabled');
      return;
    }

    // Use ReliabilityManager for reliable delivery
    if (!this.reliableManager) {
      console.warn('ReliabilityManager not available, cannot process reliable delivery');
      return;
    }

    try {
      const ready = this.reliableManager.add(streamData, (sourceId, start, end) => {
        if (this.socket && this.socket.connected) {
          this.socket.emit('requestRetransmission', { sourceId: sourceId, startSeq: start, endSeq: end });
        }
      });
      
      if (Array.isArray(ready) && ready.length > 0) {
        for (const pkt of ready) {
          try {
            this.playAudioDataPure(pkt);
          } catch (e) {
            console.warn('playAudioDataPure failed for packet:', e);
            // Try to recover by playing the next packet
            continue;
          }
        }
      }
    } catch (e) {
      console.error('Fatal error in reliable delivery:', e);
      // Try to play the current packet directly as fallback
      try {
        this.playAudioDataPure(streamData);
      } catch (fallbackError) {
        console.error('Fallback playback also failed:', fallbackError);
      }
    }
    // If ReliabilityManager is not available, warn and skip
    console.warn('ReliabilityManager not available, cannot process reliable delivery');
    return;
  }

  // Request missing packets with throttling
  requestRetransmission(sourceId, startSeq, endSeq) {
    if (!this.socket) return;
    
    // Throttle retransmission requests to prevent flooding
    const now = Date.now();
    const key = `${sourceId}-${startSeq}-${endSeq}`;
    if (this.lastRetransmissionRequest && this.lastRetransmissionRequest[key]) {
      const timeSinceLastRequest = now - this.lastRetransmissionRequest[key];
      if (timeSinceLastRequest < this.retransmissionTimeout) {
        return; // Too soon, skip request
      }
    }
    
    if (!this.lastRetransmissionRequest) {
      this.lastRetransmissionRequest = {};
    }
    this.lastRetransmissionRequest[key] = now;
    
    // Limit range to prevent excessive requests
    const maxRange = 50;
    if (endSeq - startSeq > maxRange) {
      endSeq = startSeq + maxRange;
    }
    
    console.log(`Requesting retransmission for ${sourceId}: seq ${startSeq}-${endSeq}`);
    this.socket.emit('requestRetransmission', {
      sourceId: sourceId,
      startSeq: startSeq,
      endSeq: endSeq
    });
  }

  // Main playback entry point - process through queue like old app
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
    this.metrics.packetsReceived++;

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

        if (frames <= 0) {
          console.warn('Empty audio buffer in queue, skipping');
          continue;
        }

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
        } else if (this.playbackGain) {
          src.connect(this.playbackGain);
        } else {
          // Fallback: connect directly to destination if playbackGain is null
          src.connect(this.audioContext.destination);
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

        // Aggressive transient detection for modern production
        if (!this.features.reliableDelivery) {
          try {
            for (let c = 0; c < audioBuffer.numberOfChannels; c++) {
              const d = audioBuffer.getChannelData(c);
              let lastSample = 0;
              let transientCount = 0;
              
              for (let i = 0; i < d.length; i++) {
                const sample = d[i];
                const change = Math.abs(sample - lastSample);
                
                // More aggressive detection for modern production
                if (change > 0.2 || (i > 0 && change > 0.1 && Math.abs(d[i-1] - (i > 1 ? d[i-2] : 0)) > 0.1)) {
                  transientCount++;
                  // Softer limiting for transients
                  const targetMax = 0.7;
                  if (Math.abs(sample) > targetMax) {
                    d[i] = Math.sign(sample) * targetMax;
                  }
                  
                  // Smooth the transition more aggressively for modern tracks
                  if (i > 0 && change > 0.15) {
                    const blend = 0.3; // More aggressive blending
                    d[i] = lastSample * (1 - blend) + sample * blend;
                  }
                }
                
                lastSample = d[i];
              }
              
              if (transientCount > 10) {
                console.log(`Channel ${c}: ${transientCount} transients detected and smoothed`);
              }
            }
          } catch (e) {
            console.warn('Transient detection error:', e);
          }
        }

        try {
          // crossfade / smoothing
          const sr = audioBuffer.sampleRate;
          const frames = audioBuffer.length;
          // --- Minimal guarded crossfade & fade-in (reintroduced safely) ---
          const wantMs = Math.min(this.maxCrossfadeMs, Math.max(this.minCrossfadeMs, (frames / sr) * 1000 * 0.12));
          const overlapSamples = Math.min(Math.floor(sr * (wantMs / 1000)), Math.floor(frames / 3));
          if (this.features.conditionalFade && this.lastTailSamples && overlapSamples > 8) {
            for (let c = 0; c < audioBuffer.numberOfChannels; c++) {
              const d = audioBuffer.getChannelData(c);
              const prev = this.lastTailSamples[c];
              if (!prev) continue;
              const ov = Math.min(overlapSamples, prev.length, d.length);
              // Validate previous tail (avoid propagating corruption)
              let corrupt = false;
              for (let i = 0; i < ov; i++) { const v = prev[prev.length - ov + i]; if (!isFinite(v) || Math.abs(v) > 1) { corrupt = true; break; } }
              if (corrupt) continue;
              for (let i = 0; i < ov; i++) {
                const w = 0.5 * (1 - Math.cos(Math.PI * i / (ov - 1 || 1))); // Hann
                const prevW = 1 - w;
                d[i] = prev[prev.length - ov + i] * prevW + d[i] * w;
              }
            }
          } else if (this.features.conditionalFade) {
            // Gentle 0.6ms – 1.2ms fade-in depending on buffer length
            const fadeSamples = Math.min(Math.max(32, Math.floor(sr * 0.0006)), Math.floor(frames / 4));
            for (let c = 0; c < audioBuffer.numberOfChannels; c++) {
              const d = audioBuffer.getChannelData(c);
              for (let i = 0; i < fadeSamples; i++) {
                const w = 0.5 * (1 - Math.cos(Math.PI * i / (fadeSamples - 1 || 1)));
                d[i] *= w;
              }
            }
          }
          // Store new tails for next crossfade
          this.lastTailSamples = [];
          const keep = Math.min(overlapSamples * 2 || 128, frames);
          for (let c = 0; c < audioBuffer.numberOfChannels; c++) {
            const d = audioBuffer.getChannelData(c);
            const tail = new Float32Array(keep);
            tail.set(d.subarray(d.length - keep));
            this.lastTailSamples[c] = tail;
          }
          // --- end minimal crossfade block ---
        } catch (_) { }
        
        try { src.start(startAt); } catch (e) { try { src.start(); } catch (_) { } }
        // maintain nextPlayTime for UI backward compatibility
        this.nextPlayTime = startAt + audioBuffer.duration;
        this.metrics.packetsPlayed++;

        src.onended = () => { try { this.activeSources.delete(src); } catch (_) { } };
        this.activeSources.add(src);

        // allow event loop to breathe (no visible jitter)
        await new Promise(r => setTimeout(r, 0));
      } catch (e) {
        console.warn('processAudioQueue error', e);
      }
    }

    this.isProcessingQueue = false;
  }

  // Reset audio timing when switching modes or recovering from errors
  resetAudioTiming() {
    this.nextPlayTime = 0;
    this.playCursorSamples = 0;
    this._anchorTime = 0;
    this.lastTailSamples = null;
    // Stop all active sources
    for (const source of this.activeSources || []) {
      try { source.stop(0); } catch(_) {}
    }
    this.activeSources.clear();
  }

  updatePlaybackStatus() {
    // Simple status update for queue monitoring
    const queueMs = this.audioQueue.reduce((acc, item) => {
      const ch = item.channels || 1;
      return acc + (item.data.length / (item.sampleRate * ch)) * 1000;
    }, 0);
    
    if (this.debugPanelVisible) {
      this._updateDebugPanel();
    }
  }

  // Pure audio playback: no enhancements, direct to audio context with proper timing
  async playAudioDataPure(streamData) {
    if (!this.audioContext || !streamData || !streamData.data) return;

    // Ensure audio context is running
    if (this.audioContext.state === 'suspended') {
      try {
        await this.audioContext.resume();
      } catch (e) {
        console.warn('Failed to resume audio context:', e);
        return;
      }
    }

    // Normalize buffer
    let srcBuffer;
    if (streamData.data instanceof ArrayBuffer) srcBuffer = streamData.data;
    else if (ArrayBuffer.isView(streamData.data)) srcBuffer = streamData.data.buffer.slice(streamData.data.byteOffset, streamData.data.byteOffset + streamData.data.byteLength);
    else if (Array.isArray(streamData.data)) { const t = new Float32Array(streamData.data.length); t.set(streamData.data); srcBuffer = t.buffer; }
    else return;

    const srcRate = streamData.sampleRate || 48000;
    const channels = streamData.channels || 1;
    let interleaved = new Float32Array(srcBuffer);

    // Resample if needed
    const targetRate = this.audioContext.sampleRate;
    if (srcRate !== targetRate) {
      try {
        interleaved = await this.resampleInterleaved(interleaved, srcRate, targetRate, channels);
      } catch (e) {
        console.warn('resample error, using raw buffer', e);
      }
    }

    // Create audio buffer
    const frames = Math.floor(interleaved.length / channels);
    if (frames <= 0) {
      console.warn('Empty audio buffer, skipping playback');
      return;
    }

    try {
      const audioBuffer = this.audioContext.createBuffer(channels, frames, targetRate);
      for (let c = 0; c < channels; c++) {
        const chData = audioBuffer.getChannelData(c);
        for (let i = 0, k = c; i < frames; i++, k += channels) {
          const sample = interleaved[k] || 0;
          // Clamp values to prevent distortion
          chData[i] = Math.max(-1, Math.min(1, sample));
        }
      }

      const src = this.audioContext.createBufferSource();
      src.buffer = audioBuffer;
      
      // Ensure playback gain exists and is connected
      if (!this.playbackGain) {
        console.warn('Playback gain not initialized, creating default');
        this.playbackGain = this.audioContext.createGain();
        this.playbackGain.connect(this.audioContext.destination);
      }
      
      src.connect(this.playbackGain);

      // FIXED: Proper timing coordination for reliable delivery
      const now = this.audioContext.currentTime;
      
      // Initialize timing if needed
      if (this.nextPlayTime === 0 || this.nextPlayTime < now) {
        this.nextPlayTime = now + this.fixedLatency;
        this._anchorTime = now;
        this.playCursorSamples = 0;
      }

      // Schedule at proper time to prevent overlapping and slow motion
      const playTime = Math.max(this.nextPlayTime, now + 0.001); // Minimum 1ms ahead
      
      src.start(playTime);
      this.activeSources.add(src);
      src.onended = () => this.activeSources.delete(src);
      
      // Update timing for next buffer
      const bufferDuration = frames / targetRate;
      this.nextPlayTime = playTime + bufferDuration;
      this.playCursorSamples += frames;
      
    } catch (e) {
      console.error('Failed to create or start audio source:', e);
      // Try to recover by resetting timing
      this.resetAudioTiming();
    }
  }

  /* ---------------- Cleanup ---------------- */
  cleanup() {
    this._stopScheduler();
    if (this.socket) { try { this.socket.disconnect(); } catch (_) { } this.socket = null; }
    this.stopStreaming();
    this.stopListening();
  }

  /* ---------------- Removed: Adaptive Jitter Logic ---------------- */
  // Old adaptive jitter logic removed - now using simple fixed latency

  /* ---------------- Simple Gap Management (removed complex budget logic) ---------------- */
  // Old complex gap management removed - now using simple reliable delivery

  // Concealment frames handled by reliable delivery now

  _resetSync() {
    // Clear audio queue and reset scheduling anchor
    this.audioQueue = [];
    this.nextPlayTime = 0;
    this.lastScheduleTime = 0;
    this.lastPlayedTimestamp = 0;
    this._latBehindEma = 0;
    // Stop all active sources
    for (const source of this.activeSources || []) {
      try { source.stop(0); } catch(_) {}
    }
    this.activeSources.clear();
    this.showToast('Playback sync reset', 'info');
  }

  _isLateUnreliable(pkt) {
    // If not in unreliable mode just false
    if (this.features.reliableDelivery) return false;
    if (!this.audioContext) return false;
    // Consider late if audioQueue has too many items (simple check)
    // and packet timestamp is older than lastPlayedTimestamp by > 200ms
    if (this.audioQueue.length > 10) { // Simple threshold instead of jitter buffer check
      if (this.lastPlayedTimestamp && pkt.timestamp && (this.lastPlayedTimestamp - pkt.timestamp) > 200) return true;
    }
    return false;
  }



  /* ---------------- Debug Panel ---------------- */
  _ensureDebugPanel() {
    let panel = document.getElementById('appDebugPanel');
    if (!panel) {
      panel = document.createElement('div');
      panel.id = 'appDebugPanel';
      panel.style.cssText = 'position:fixed;bottom:8px;right:8px;z-index:9999;background:rgba(0,0,0,0.68);color:#fff;font:12px/1.3 monospace;padding:6px 8px;border-radius:6px;';
      panel.innerHTML = '<div style="font-weight:bold;margin-bottom:4px;">Audio Metrics</div><pre id="appDebugMetrics" style="margin:0;white-space:pre-wrap;"></pre><button id="appDebugClose" class="btn btn-sm btn-secondary" style="margin-top:4px;">Close</button>';
      document.body.appendChild(panel);
      panel.querySelector('#appDebugClose').addEventListener('click', () => { this.debugPanelVisible = false; panel.remove(); });
    }
  }

  _updateDebugPanel() {
    if (!this.debugPanelVisible) return;
    this._ensureDebugPanel();
    const el = document.getElementById('appDebugMetrics');
    if (!el) return;
    const queueMs = this.audioQueue.reduce((acc, item) => {
      const ch = item.channels || 1;
      return acc + (item.data.length / (item.sampleRate * ch)) * 1000;
    }, 0).toFixed(0);
    el.textContent = [
      `recv: ${this.metrics.packetsReceived}`,
      `play: ${this.metrics.packetsPlayed}`,
      `underrun: ${this.metrics.underruns}`,
      `queue(ms): ${queueMs}`,
      `latency(ms): ${Math.round(this.fixedLatency * 1000)}`,
      `mode: ${this.features.reliableDelivery ? 'reliable-pure' : 'standard'}`,
      `sources: ${this.activeSources.size}`
    ].join('\n');
  }

  // Public debug API
  enableDebugPanel(show = true) { this.debugPanelVisible = show; if (!show) { const p = document.getElementById('appDebugPanel'); p && p.remove(); } }

  _applyEqPreset(preset) {
    const gains = {
      flat: {60:0,250:0,1000:0,4000:0,12000:0},
      bass: {60:6,250:3,1000:0,4000:-1,12000:-2},
      treble: {60:-2,250:-1,1000:0,4000:3,12000:5},
      vshape: {60:4,250:2,1000:-2,4000:3,12000:4},
      voice: {60:-3,250:-1,1000:3,4000:4,12000:2},
      warm: {60:3,250:2,1000:1,4000:-1,12000:-2}
    };
    const g = gains[preset] || gains.flat;
    Object.entries(g).forEach(([f,val]) => { if (this.eqNodes[f]) this.eqNodes[f].gain.value = val; });
  }

  _setPlaybackMode(mode) {
    // Adjust base latency based on mode - simple approach
    if (mode === 'ultra') {
      this.fixedLatency = 0.07;
    } else if (mode === 'stable') {
      this.fixedLatency = 0.15;
    } else {
      this.fixedLatency = 0.12; // default/low mode
    }
    // Reset timing when changing modes
    this.nextPlayTime = 0;
    this._updatePlaybackStatus('Mode: ' + mode);
    this.playbackMode = mode;
    this._persistUserSettings && this._persistUserSettings();
  }

  // Public debug API
  enableDebugPanel(show = true) { this.debugPanelVisible = show; if (!show) { const p = document.getElementById('appDebugPanel'); p && p.remove(); } }
  // toggleBypassJitter removed - no longer using jitter buffer

  /* ---------------- UI Helpers (minimal) ---------------- */
  updateDeviceList(devices) {
    const listEl = document.getElementById('deviceList');
    if (!listEl) return;
    listEl.innerHTML = '';
    const searchVal = (document.getElementById('deviceSearch')?.value || '').toLowerCase().trim();
    const filtered = devices.filter(d => {
      if (!searchVal) return true;
      return (d.name||'').toLowerCase().includes(searchVal) || (d.ip||'').toLowerCase().includes(searchVal);
    });
    this._lastDevices = devices.slice();
    filtered.forEach(d => {
      const row = document.createElement('div');
      row.className = 'd-flex align-items-center justify-content-between py-2 border-bottom';
      const left = document.createElement('div');
      const lCount = this.listenerCounts[d.id] || 0;
      left.innerHTML = `<div class=\"fw-semibold\">${d.name || d.id} ${d.isStreaming ? `<span class=\"badge bg-primary ms-1\" title=\"listeners\">${lCount}</span>` : ''}</div><div class=\"text-muted small\">${d.ip || ''}</div>`;
      const right = document.createElement('div');
      if (d.isStreaming) {
        const btn = document.createElement('button');
        btn.className = 'btn btn-sm btn-outline-primary';
        btn.textContent = (this.isListening && this.listeningToSource === d.id) ? 'Stop' : 'Listen';
        btn.addEventListener('click', () => {
          if (this.isListening && this.listeningToSource === d.id) this.stopListening(); else this.startListening(d.id);
          btn.textContent = (this.isListening && this.listeningToSource === d.id) ? 'Stop' : 'Listen';
        });
        right.appendChild(btn);
      } else {
        const disabled = document.createElement('button'); disabled.className = 'btn btn-sm btn-secondary'; disabled.disabled = true; disabled.textContent = 'Not streaming'; right.appendChild(disabled);
      }
      row.appendChild(left); row.appendChild(right); listEl.appendChild(row);
    });
    const countEl = document.getElementById('onlineDeviceCount');
    if (countEl) countEl.textContent = `${devices.length} online`;
  }

  _filterDeviceList() {
    // Debounced local filtering without re-querying server on every keystroke
    if (this._searchDebounce) clearTimeout(this._searchDebounce);
    this._searchDebounce = setTimeout(() => {
      if (this._lastDevices && this._lastDevices.length) {
        this.updateDeviceList(this._lastDevices);
      } else {
        // Fallback: if we have no cache yet, request once
        this.discoverDevices();
      }
    }, 140); // slight delay to avoid excessive re-renders
  }

  async detectLocalIP() {
    try {
      const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
      pc.createDataChannel('');
      const offer = await pc.createOffer(); await pc.setLocalDescription(offer);
      const ip = await new Promise(res => {
        pc.onicecandidate = ev => { if (!ev.candidate) return; const m = ev.candidate.candidate.match(/(\d+\.\d+\.\d+\.\d+)/); if (m) { res(m[1]); pc.close(); } };
        setTimeout(() => { res('localhost'); pc.close(); }, 1500);
      });
      const el = document.getElementById('localIP'); if (el) el.textContent = `${ip}:3001`;
    } catch { const el = document.getElementById('localIP'); if (el) el.textContent = 'localhost:3001'; }
  }

  async getDeviceName() {
    try {
      const ua = navigator.userAgent || '';
      if (ua.includes('Windows')) return 'Windows PC';
      if (ua.includes('Mac')) return 'Mac';
      if (ua.includes('Linux')) return 'Linux';
      if (/Android/.test(ua)) return 'Android';
      if (/iPhone|iPad/.test(ua)) return 'iOS';
    } catch { /* ignore */ }
    return 'Unknown Device';
  }

  _updateStreamingUI() {
    const startBtn = document.getElementById('startStreamBtn');
    const stopBtn = document.getElementById('stopStreamBtn');
    const live = document.getElementById('liveIndicator');
    const countEl = document.getElementById('connectedCount');
    if (startBtn && stopBtn) {
      if (this.isStreaming) { 
        startBtn.classList.add('d-none'); 
        stopBtn.classList.remove('d-none'); 
      } else { 
        startBtn.classList.remove('d-none'); 
        stopBtn.classList.add('d-none'); 
      }
    }
    if (live) {
      if (this.isStreaming) {
        live.classList.remove('d-none');
        if (countEl && this.socket && this.socket.id) {
          const c = this.listenerCounts ? (this.listenerCounts[this.socket.id] || 0) : 0;
          countEl.textContent = String(c);
        }
      } else {
        live.classList.add('d-none');
      }
    }
  }

  showToast(message, type = 'info') {
    const container = document.getElementById('toastContainer');
    if (!container) { console.log(type.toUpperCase()+':', message); return; }
    const id = 't' + Date.now();
    const bg = type === 'error' ? 'bg-danger' : type === 'success' ? 'bg-success' : type === 'warning' ? 'bg-warning text-dark' : 'bg-info';
    const forceDark = bg.includes('bg-warning'); const textCls = forceDark ? '' : 'text-white';
    const safe = String(message).replace(/[<>]/g, s => s === '<' ? '&lt;' : '&gt;');
    container.insertAdjacentHTML('beforeend', `<div id="${id}" class="toast ${bg} ${textCls}" role="alert" aria-live="assertive" aria-atomic="true" style="min-width:200px;margin-bottom:6px;"><div class="d-flex"><div class="toast-body">${safe}</div><button type="button" class="btn-close ${forceDark ? '' : 'btn-close-white'} me-2 m-auto" data-bs-dismiss="toast"></button></div></div>`);
    const el = document.getElementById(id);
    try {
      if (typeof bootstrap !== 'undefined' && bootstrap.Toast) {
        const t = new bootstrap.Toast(el, { delay: 3500 }); t.show(); el.addEventListener('hidden.bs.toast', () => el.remove());
      } else setTimeout(() => el && el.remove(), 3500);
    } catch { setTimeout(() => el && el.remove(), 3500); }
  }

  /* ---------------- Persistence & File Source & Logging ---------------- */
  _persistUserSettings() {
    try {
      const data = {
        playbackMode: this.playbackMode,
        reliable: this.features.reliableDelivery,
        eqPreset: (document.getElementById('eqPreset')||{}).value || 'flat',
        naturalBypass: !!document.getElementById('naturalBypass')?.checked
      };
      localStorage.setItem('audioTransferSettings', JSON.stringify(data));
    } catch(_){}
  }
  _restoreUserSettings() {
    try {
      const raw = localStorage.getItem('audioTransferSettings'); if (!raw) return;
      const s = JSON.parse(raw);
      if (s.reliable != null) { const cb = document.getElementById('reliableDelivery'); if (cb) cb.checked = s.reliable; this.features.reliableDelivery = !!s.reliable; }
      if (s.eqPreset) { const sel = document.getElementById('eqPreset'); if (sel) sel.value = s.eqPreset; }
      if (s.naturalBypass != null) { const nb = document.getElementById('naturalBypass'); if (nb) nb.checked = !!s.naturalBypass; }
      if (s.playbackMode) {
        if (s.playbackMode === 'ultra') document.getElementById('modeUltraLow')?.click();
        else if (s.playbackMode === 'stable') document.getElementById('modeHighStab')?.click();
        else document.getElementById('modeLowLat')?.click();
      }
      if (s.eqPreset) this._applyEqPreset(s.eqPreset);
      // Settings loaded - no need for _applyPlaybackModeLatency since modes set fixedLatency directly
    } catch(_){}
  }

  _log(ev, meta={}) { if (!this._loggingEnabled) return; const e={t:Date.now(),ev,...meta}; this._logs.push(e); if (this._logs.length>this._logLimit) this._logs.shift(); }
  _downloadLogs() { try { const blob=new Blob([JSON.stringify(this._logs,null,2)],{type:'application/json'}); const a=document.createElement('a'); a.href=URL.createObjectURL(blob); a.download='audio-transfer-logs.json'; a.click(); setTimeout(()=>URL.revokeObjectURL(a.href),1500);} catch(e){ this.showToast('Failed to download logs','error'); }}
  async _pickLocalFile(){ return await new Promise(res=>{ const input=document.createElement('input'); input.type='file'; input.accept='audio/*'; input.onchange=()=>res(input.files&&input.files[0]); input.click(); setTimeout(()=>res(null),15000); }); }
  async _startFileStreaming(file, quality){
    try {
      const arr = await file.arrayBuffer();
      const ac = new (window.AudioContext||window.webkitAudioContext)();
      const decoded = await ac.decodeAudioData(arr.slice(0));
      const target = {low:22050,medium:44100,high:44100,ultra:48000}[quality]||44100;
      const channels = Math.min(2, decoded.numberOfChannels);
      let inter;
      if (decoded.sampleRate !== target) {
        const off = new (window.OfflineAudioContext||window.webkitOfflineAudioContext)(channels, Math.ceil(decoded.length * target / decoded.sampleRate), target);
        const src = off.createBufferSource(); src.buffer = decoded; src.connect(off.destination); src.start();
        const rendered = await off.startRendering();
        const f = rendered.length; inter = new Float32Array(f*channels); for(let c=0;c<channels;c++){ const d=rendered.getChannelData(c); for(let i=0;i<f;i++) inter[i*channels+c]=d[i]; }
      } else {
        const f = decoded.length; inter = new Float32Array(f*channels); for(let c=0;c<channels;c++){ const d=decoded.getChannelData(c); for(let i=0;i<f;i++) inter[i*channels+c]=d[i]; }
      }
      ac.close();
      this.isStreaming = true; this._updateStreamingUI && this._updateStreamingUI();
      const deviceName = await this.getDeviceName();
      this.socket.emit('startStreaming', { source:'file', quality, deviceName });
      this.showToast('Streaming file: '+file.name,'success');
      const frameSamples = Math.round(target * 0.02); let off=0; const totalFrames = Math.floor(inter.length / channels);
      const frameDurationMs = 20; let sent = 0; const startTs = performance.now();
      const pump = () => {
        if (!this.isStreaming) return;
        if (off >= totalFrames) { this.stopStreaming(); return; }
        const expectedElapsed = sent * frameDurationMs;
        const actualElapsed = performance.now() - startTs;
        const drift = actualElapsed - expectedElapsed;
        const remain = totalFrames - off; const take = Math.min(frameSamples, remain);
        const chunk = new Float32Array(take*channels); chunk.set(inter.subarray(off*channels,(off+take)*channels)); off += take;
        this._emitCaptured({ audioBuffer: chunk.buffer, sampleRate: target, channels });
        sent++;
        const nextDelay = Math.max(0, frameDurationMs - drift);
        this._fileStreamTimer = setTimeout(pump, nextDelay);
      };
      pump();
      this._log && this._log('file_stream_start', { name: file.name, sampleRate: target, channels });
    } catch(e) { this.showToast('File streaming failed: '+e.message,'error'); }
  }
}

window.app_next = new AudioTransferApp();
// Backward compatibility alias
window.app = window.app_next;
