// Audio Transfer App - Main JavaScript File

class AudioTransferApp {
    constructor() {
        this.socket = null;
        this.mediaStream = null;
        this.audioContext = null;
        this.isStreaming = false;
        this.connectedDevices = [];
        this.currentConnection = null;
        
        this.init();
    }

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

    initSocket() {
        // Connect to Socket.IO server
        this.socket = io();
        
        this.socket.on('connect', () => {
            console.log('Connected to server');
            this.showToast('Connected to server', 'success');
        });

        this.socket.on('disconnect', () => {
            console.log('Disconnected from server');
            this.showToast('Disconnected from server', 'warning');
        });

        this.socket.on('deviceList', (devices) => {
            this.updateDeviceList(devices);
        });

        this.socket.on('clientConnected', (clientInfo) => {
            this.connectedDevices.push(clientInfo);
            this.updateConnectedCount();
            this.showToast(`${clientInfo.name} connected`, 'success');
        });

        this.socket.on('clientDisconnected', (clientInfo) => {
            this.connectedDevices = this.connectedDevices.filter(d => d.id !== clientInfo.id);
            this.updateConnectedCount();
            this.showToast(`${clientInfo.name} disconnected`, 'info');
        });
    }

    setupEventListeners() {
        // Stream controls
        document.getElementById('startStreamBtn').addEventListener('click', () => this.startStreaming());
        document.getElementById('stopStreamBtn').addEventListener('click', () => this.stopStreaming());
        
        // Device discovery
        document.getElementById('refreshDevices').addEventListener('click', () => this.discoverDevices());
        
        // Manual connection
        document.getElementById('manualConnect').addEventListener('click', () => this.manualConnect());
        
        // Device search
        document.getElementById('deviceSearch').addEventListener('input', (e) => this.filterDevices(e.target.value));
        
        // Audio source selection
        document.querySelectorAll('input[name="audioSource"]').forEach(input => {
            input.addEventListener('change', (e) => this.onAudioSourceChange(e.target.value));
        });
        
        // Quality selection
        document.querySelectorAll('input[name="quality"]').forEach(input => {
            input.addEventListener('change', (e) => this.onQualityChange(e.target.value));
        });
    }

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

    async startStreaming() {
        try {
            const startBtn = document.getElementById('startStreamBtn');
            const stopBtn = document.getElementById('stopStreamBtn');
            const liveIndicator = document.getElementById('liveIndicator');
            const serverStatus = document.getElementById('serverStatus');
            
            startBtn.disabled = true;
            startBtn.innerHTML = '<span class="spinner-border spinner-border-sm me-2"></span>Starting...';
            
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
            this.isStreaming = true;
            startBtn.classList.add('d-none');
            stopBtn.classList.remove('d-none');
            liveIndicator.classList.remove('d-none');
            serverStatus.textContent = 'LIVE';
            serverStatus.className = 'badge bg-success';
            
            this.showToast('Streaming started successfully!', 'success');
            
        } catch (error) {
            console.error('Failed to start streaming:', error);
            this.showToast('Failed to start streaming: ' + error.message, 'error');
            
            // Reset button
            const startBtn = document.getElementById('startStreamBtn');
            startBtn.disabled = false;
            startBtn.innerHTML = '<i class="bi bi-play-fill me-2"></i>Start Streaming';
        }
    }

    stopStreaming() {
        try {
            const startBtn = document.getElementById('startStreamBtn');
            const stopBtn = document.getElementById('stopStreamBtn');
            const liveIndicator = document.getElementById('liveIndicator');
            const serverStatus = document.getElementById('serverStatus');
            
            // Stop media stream
            if (this.mediaStream) {
                this.mediaStream.getTracks().forEach(track => track.stop());
                this.mediaStream = null;
            }
            
            // Stop audio context
            if (this.audioContext) {
                this.audioContext.close();
                this.audioContext = null;
            }
            
            // Notify server
            this.socket.emit('stopStreaming');
            
            // Update UI
            this.isStreaming = false;
            this.connectedDevices = [];
            stopBtn.classList.add('d-none');
            startBtn.classList.remove('d-none');
            liveIndicator.classList.add('d-none');
            serverStatus.textContent = 'OFFLINE';
            serverStatus.className = 'badge bg-secondary';
            
            this.updateConnectedCount();
            this.showToast('Streaming stopped', 'info');
            
        } catch (error) {
            console.error('Error stopping stream:', error);
            this.showToast('Error stopping stream', 'error');
        }
    }

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
                // System audio capture (limited browser support)
                try {
                    return await navigator.mediaDevices.getDisplayMedia({
                        audio: {
                            sampleRate: settings.sampleRate,
                            channelCount: 2
                        },
                        video: false
                    });
                } catch (error) {
                    throw new Error('System audio capture not supported or permission denied');
                }
                
            case 'file':
                // File input would be handled differently
                throw new Error('File input not implemented yet');
                
            default:
                throw new Error('Unknown audio source');
        }
    }

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

    streamAudioData(source) {
        const processor = this.audioContext.createScriptProcessor(4096, 2, 2);
        
        processor.onaudioprocess = (e) => {
            if (!this.isStreaming) return;
            
            const inputBuffer = e.inputBuffer;
            const outputBuffer = e.outputBuffer;
            
            // Process audio data
            for (let channel = 0; channel < inputBuffer.numberOfChannels; channel++) {
                const inputData = inputBuffer.getChannelData(channel);
                const outputData = outputBuffer.getChannelData(channel);
                
                // Copy input to output
                for (let i = 0; i < inputBuffer.length; i++) {
                    outputData[i] = inputData[i];
                }
                
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

    async getDeviceName() {
        // Try to get a meaningful device name
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

    updateDeviceList(devices) {
        const deviceList = document.getElementById('deviceList');
        const onlineCount = devices.filter(d => d.status === 'online').length;
        
        document.getElementById('onlineDeviceCount').textContent = `${onlineCount} online`;
        
        if (devices.length === 0) {
            deviceList.innerHTML = `
                <div class="text-center py-5">
                    <i class="bi bi-search text-muted" style="font-size: 3rem;"></i>
                    <p class="text-muted mt-3">No devices found</p>
                    <p class="text-muted">Try refreshing or check your network</p>
                </div>
            `;
            return;
        }
        
        deviceList.innerHTML = devices.map(device => `
            <div class="card device-card bg-dark border-secondary mb-3 ${device.status === 'offline' ? 'offline' : ''} ${this.currentConnection?.id === device.id ? 'connected' : ''}">
                <div class="card-body">
                    <div class="d-flex justify-content-between align-items-center">
                        <div class="d-flex align-items-center">
                            <div class="bg-${device.status === 'online' ? 'primary' : 'secondary'} rounded-3 p-2 me-3">
                                <i class="bi bi-${this.getDeviceIcon(device.type)} text-white"></i>
                            </div>
                            <div>
                                <h6 class="mb-1 ${device.status === 'offline' ? 'text-muted' : ''}">${device.name}</h6>
                                <small class="text-muted font-monospace">${device.ip}:${device.port}</small>
                            </div>
                        </div>
                        <div class="text-end">
                            <span class="badge bg-${device.status === 'online' ? 'success' : 'secondary'} mb-2">${device.status}</span>
                            <br>
                            ${this.currentConnection?.id === device.id ? 
                                '<span class="text-success"><i class="bi bi-check-circle me-1"></i>Connected</span>' :
                                `<button class="btn btn-sm btn-primary" onclick="app.connectToDevice('${device.id}')" ${device.status === 'offline' ? 'disabled' : ''}>
                                    Connect
                                </button>`
                            }
                        </div>
                    </div>
                </div>
            </div>
        `).join('');
    }

    getDeviceIcon(type) {
        switch (type) {
            case 'desktop': return 'pc-display';
            case 'mobile': return 'phone';
            case 'tablet': return 'tablet';
            default: return 'speaker';
        }
    }

    connectToDevice(deviceId) {
        this.showToast('Connecting to device...', 'info');
        this.socket.emit('connectToDevice', deviceId);
        
        // Handle connection response
        this.socket.once('connectionResult', (result) => {
            if (result.success) {
                this.currentConnection = result.device;
                this.showToast(`Connected to ${result.device.name}`, 'success');
                this.updateDeviceList([]); // Refresh list
            } else {
                this.showToast(`Failed to connect: ${result.error}`, 'error');
            }
        });
    }

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

    onAudioSourceChange(source) {
        console.log('Audio source changed to:', source);
        // Handle audio source change
    }

    onQualityChange(quality) {
        console.log('Quality changed to:', quality);
        // Handle quality change
    }

    updateConnectedCount() {
        document.getElementById('connectedCount').textContent = this.connectedDevices.length;
    }

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
        
        const toastHTML = `
            <div class="toast align-items-center ${bgClass} border-0" id="${toastId}" role="alert">
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
        
        // Remove toast after it's hidden
        toastElement.addEventListener('hidden.bs.toast', () => {
            toastElement.remove();
        });
    }
}

// Initialize app when DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
    window.app = new AudioTransferApp();
});

// Export for potential module use
if (typeof module !== 'undefined' && module.exports) {
    module.exports = AudioTransferApp;
}