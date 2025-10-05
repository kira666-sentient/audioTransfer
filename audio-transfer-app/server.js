import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { networkInterfaces } from 'os';

// ES Module __dirname equivalent
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

class AudioTransferServer {
    constructor() {
        this.app = express();
        this.server = createServer(this.app);
        this.io = new Server(this.server, {
            cors: {
                origin: process.env.ALLOWED_ORIGINS ? 
                    process.env.ALLOWED_ORIGINS.split(',') : 
                    true, // Allow all origins for local development
                methods: ["GET", "POST"],
                credentials: false
            },
            allowEIO3: true, // Support older clients
            transports: ['websocket', 'polling'], // Ensure both transports work
            // Optimized for high-quality audio streaming
            maxHttpBufferSize: 1e8, // 100MB for large audio buffers
            pingTimeout: 60000, // 60 seconds
            pingInterval: 25000, // 25 seconds  
            upgradeTimeout: 30000, // 30 seconds for upgrade
            allowUpgrades: true,
            perMessageDeflate: false, // Disable compression for audio (reduces latency)
            httpCompression: false // Disable HTTP compression for real-time audio
        });
        
        this.connectedClients = new Map();
        this.streamingClients = new Map();
        this.port = process.env.PORT || 3001;
        
        // Rate limiting for audio data - optimized for ultra-high quality
        this.audioDataRateLimit = new Map();
        this.maxAudioPacketsPerSecond = 150; // Increased for ultra-high quality audio (96kHz/192kHz support)
        this.rateLimitWarnings = new Map(); // Track warnings sent to clients
        
        // Reliable delivery: store recent packets for retransmission - optimized for quality
        this.packetHistory = new Map(); // sourceId -> Map(seq -> packet)
        this.maxHistorySize = 400; // Significantly increased for ultra-reliable delivery
        
        // Audio quality monitoring
        this.audioQualityStats = new Map(); // sourceId -> quality stats
        this.qualityCheckInterval = 5000; // Check quality every 5 seconds
        
        this.setupMiddleware();
        this.setupRoutes();
        this.setupSocketHandlers();
        this.startQualityMonitoring();
    }

    setupMiddleware() {
        // Enable CORS
        this.app.use(cors());
        
        // Parse JSON
        this.app.use(express.json());
        
        // Serve static files
        this.app.use(express.static(__dirname));
        
        // Logging middleware
        this.app.use((req, res, next) => {
            console.log(`${new Date().toISOString()} - ${req.method} ${req.url}`);
            next();
        });
    }

    setupRoutes() {
        // Main route
        this.app.get('/', (req, res) => {
            res.sendFile(join(__dirname, 'index.html'));
        });

        // API endpoints
        this.app.get('/api/status', (req, res) => {
            res.json({
                status: 'running',
                connectedClients: this.connectedClients.size,
                streamingClients: this.streamingClients.size,
                serverTime: new Date().toISOString(),
                localIP: this.getLocalIP()
            });
        });

        this.app.get('/api/devices', (req, res) => {
            const devices = Array.from(this.connectedClients.values()).map(client => ({
                id: client.id,
                name: client.name,
                ip: client.ip,
                port: this.port,
                type: client.type,
                status: 'online',
                isStreaming: this.streamingClients.has(client.id)
            }));
            
            res.json(devices);
        });

        // Health check
        this.app.get('/health', (req, res) => {
            res.json({ status: 'healthy', timestamp: new Date().toISOString() });
        });
    }

    setupSocketHandlers() {
        this.io.on('connection', (socket) => {
            console.log(`Client connected: ${socket.id}`);

            // Register client
            const clientInfo = {
                id: socket.id,
                name: `Device-${socket.id.substring(0, 6)}`,
                ip: this.getClientIP(socket),
                type: 'unknown',
                connectedAt: new Date(),
                isStreaming: false
            };
            this.connectedClients.set(socket.id, clientInfo);
            this.broadcastDeviceList();

            // Handle streaming events
            socket.on('startStreaming', (data) => {
                // Validate streaming configuration
                if (!data || typeof data !== 'object') {
                    console.warn(`Invalid streaming config from ${socket.id}`);
                    socket.emit('streamingStarted', {
                        success: false,
                        message: 'Invalid streaming configuration'
                    });
                    return;
                }
                const validSources = ['microphone', 'system', 'file'];
                const validQualities = ['low', 'medium', 'high', 'ultra'];
                if (!validSources.includes(data.source) || !validQualities.includes(data.quality)) {
                    console.warn(`Invalid streaming parameters from ${socket.id}`);
                    socket.emit('streamingStarted', {
                        success: false,
                        message: `Invalid source (${data.source}) or quality (${data.quality})`
                    });
                    return;
                }
                
                // Check if already streaming to prevent double notifications
                const client = this.connectedClients.get(socket.id);
                if (client && client.isStreaming) {
                    console.log(`Client ${socket.id} already streaming, ignoring duplicate start`);
                    return;
                }
                
                console.log(`🎙️  ${socket.id} started streaming (${data.source}, ${data.quality})`);
                // Update client info
                if (client) {
                    client.isStreaming = true;
                    client.streamConfig = data;
                    this.streamingClients.set(socket.id, {
                        id: socket.id,
                        name: client.name,
                        ip: client.ip,
                        type: client.type,
                        streamConfig: data
                    });
                    
                    // Send success response to the streaming client
                    socket.emit('streamingStarted', {
                        success: true,
                        message: 'Streaming started successfully',
                        config: data
                    });
                    
                    // Notify other clients ONCE
                    socket.broadcast.emit('streamStarted', {
                        clientId: socket.id,
                        clientName: client?.name,
                        config: {
                            source: data.source,
                            quality: data.quality
                        }
                    });
                    this.broadcastDeviceList();
                } else {
                    socket.emit('streamingStarted', {
                        success: false,
                        message: 'Client not found'
                    });
                }
            });

            socket.on('stopStreaming', () => {
                console.log(`Client ${socket.id} stopped streaming`);
                const client = this.connectedClients.get(socket.id);
                
                // Check if actually streaming to prevent double notifications
                if (!client || !client.isStreaming) {
                    console.log(`Client ${socket.id} not streaming, ignoring duplicate stop`);
                    return;
                }
                
                // Update client state
                client.isStreaming = false;
                delete client.streamConfig;
                this.streamingClients.delete(socket.id);
                
                // Notify other clients ONCE
                socket.broadcast.emit('streamStopped', {
                    clientId: socket.id,
                    clientName: client?.name
                });
                this.broadcastDeviceList();
            });

            socket.on('audioData', (data) => {
                // Rate limiting for audio data
                const clientId = socket.id;
                const now = Date.now();
                
                if (!this.audioDataRateLimit.has(clientId)) {
                    this.audioDataRateLimit.set(clientId, { count: 0, lastReset: now });
                }
                
                const rateData = this.audioDataRateLimit.get(clientId);
                
                // Reset counter every second
                if (now - rateData.lastReset > 1000) {
                    rateData.count = 0;
                    rateData.lastReset = now;
                }
                
                // Check rate limit
                if (rateData.count > this.maxAudioPacketsPerSecond) {
                    // Send warning to client instead of spamming console
                    if (!this.rateLimitWarnings.has(clientId) || 
                        now - this.rateLimitWarnings.get(clientId) > 5000) {
                        socket.emit('rateLimitWarning');
                        this.rateLimitWarnings.set(clientId, now);
                    }
                    return;
                }
                
                rateData.count++;
                
                // Validate and normalize audio data (accept Buffer/TypedArray/ArrayBuffer/Array)
                if (!data || data.data == null || data.data === undefined) {
                    return; // Silently drop invalid data
                }
                
                // Enhanced validation for ultra-high quality audio
                if (data.channels && (typeof data.channels !== 'number' || data.channels < 1 || data.channels > 32)) {
                    console.warn(`Invalid channel count from ${socket.id}: ${data.channels}`);
                    return;
                }
                
                if (data.sampleRate && (typeof data.sampleRate !== 'number' || data.sampleRate < 8000 || data.sampleRate > 384000)) {
                    console.warn(`Invalid sample rate from ${socket.id}: ${data.sampleRate}`);
                    return;
                }
                let normalizedArrayBuffer = null;
                try {
                    const payload = data.data;
                    if (payload instanceof ArrayBuffer) {
                        normalizedArrayBuffer = payload;
                    } else if (Array.isArray(payload)) {
                        // Preserve full precision for high-quality audio
                        const f32 = new Float32Array(payload);
                        // Audio integrity check - ensure no corrupted samples
                        for (let i = 0; i < f32.length; i++) {
                            if (!Number.isFinite(f32[i])) {
                                console.warn(`Corrupted audio sample detected from ${socket.id} at index ${i}`);
                                f32[i] = 0; // Zero out corrupted samples
                            }
                        }
                        normalizedArrayBuffer = f32.buffer;
                    } else if (Buffer.isBuffer(payload)) {
                        // Bit-perfect Node Buffer handling
                        normalizedArrayBuffer = payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.byteLength);
                    } else if (ArrayBuffer.isView(payload)) {
                        // Bit-perfect TypedArray/DataView handling
                        normalizedArrayBuffer = payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.byteLength);
                    } else {
                        console.warn(`Unsupported audio data type from ${socket.id}:`, typeof payload);
                        return; // unsupported type
                    }
                    
                    // Additional integrity check for final buffer
                    if (!normalizedArrayBuffer || normalizedArrayBuffer.byteLength === 0) {
                        console.warn(`Empty audio buffer from ${socket.id}`);
                        return;
                    }
                    
                } catch (e) {
                    console.warn(`Audio data processing error from ${socket.id}:`, e.message);
                    return;
                }
                
                // Relay audio data to all listening clients with improved metadata
                const streamInfo = this.streamingClients.get(socket.id);
                if (streamInfo) {
                    // Store packet for potential retransmission
                    if (!this.packetHistory.has(socket.id)) {
                        this.packetHistory.set(socket.id, new Map());
                    }
                    const history = this.packetHistory.get(socket.id);
                    if (data.seq != null && typeof data.seq === 'number' && data.seq >= 0) {
                        // Validate sequence number to prevent corruption
                        const seq = Math.floor(data.seq) >>> 0; // Ensure it's a valid uint32
                        
                        // Store with complete high-quality metadata
                        const packetData = {
                            timestamp: data.timestamp || Date.now(),
                            data: normalizedArrayBuffer,
                            channels: Math.max(1, Math.min(32, data.channels || 1)), // Clamp to valid range
                            sampleRate: Math.max(8000, Math.min(384000, data.sampleRate || 48000)), // Clamp to valid range
                            seq: seq,
                            quality: streamInfo.streamConfig?.quality || 'high',
                            bitDepth: data.bitDepth || 32, // Assume 32-bit float if not specified
                            frameSize: normalizedArrayBuffer.byteLength,
                            receivedAt: Date.now()
                        };
                        
                        history.set(seq, packetData);
                        
                        // Update quality monitoring
                        this.updateAudioQualityStats(socket.id, packetData);
                        
                        // Efficient cleanup: maintain by sequence number with age-based pruning
                        if (history.size > this.maxHistorySize) {
                            const now = Date.now();
                            const sequences = Array.from(history.keys()).sort((a, b) => a - b);
                            let deleted = 0;
                            
                            // Delete oldest sequences or packets older than 10 seconds
                            for (const seq of sequences) {
                                const packet = history.get(seq);
                                if (deleted >= 50 || (packet.receivedAt && now - packet.receivedAt > 10000)) {
                                    history.delete(seq);
                                    deleted++;
                                }
                                if (history.size <= this.maxHistorySize * 0.8) break; // Keep 80% capacity
                            }
                        }
                    }

                    // Send audioStream with complete high-quality metadata
                    const payload = {
                        sourceId: socket.id,
                        sourceName: this.connectedClients.get(socket.id)?.name,
                        timestamp: data.timestamp || Date.now(),
                        quality: streamInfo.streamConfig?.quality || 'high',
                        channel: data.channel || 0,
                        seq: data.seq,
                        sampleIndex: data.sampleIndex,
                        frameSamples: data.frameSamples,
                        channels: Math.max(1, Math.min(32, data.channels || 1)),
                        sampleRate: Math.max(8000, Math.min(384000, data.sampleRate || 48000)),
                        bitDepth: data.bitDepth || 32, // Default to 32-bit float
                        frameSize: normalizedArrayBuffer.byteLength,
                        audioFormat: 'float32', // Specify format for client optimization
                        isLossless: true, // Indicate bit-perfect transmission
                        data: normalizedArrayBuffer
                    };
                    for (const [clientId, clientInfo] of this.connectedClients.entries()) {
                        if (clientInfo.listeningTo === socket.id) {
                            this.io.to(clientId).emit('audioStream', payload);
                        }
                    }
                }
            });

            socket.on('joinAsListener', (sourceId) => {
                console.log(`${socket.id} joining as listener to ${sourceId}`);
                const client = this.connectedClients.get(socket.id);
                if (client) {
                    // Always update the target source
                    client.type = 'listener';
                    client.listeningTo = sourceId;
                }
                
                // Notify the streaming client about new listener
                if (this.streamingClients.has(sourceId)) {
                    this.io.to(sourceId).emit('listenerJoined', {
                        listenerId: socket.id,
                        listenerName: client?.name
                    });
                }
                
                socket.emit('joinedAsListener', {
                    sourceId: sourceId,
                    sourceName: this.connectedClients.get(sourceId)?.name
                });

                // 🔸 update everyone with new listener counts
                this.broadcastListenerCounts();
            });

            socket.on('leaveAsListener', () => {
                const client = this.connectedClients.get(socket.id);
                if (client && client.listeningTo) {
                    // Notify the streaming client
                    this.io.to(client.listeningTo).emit('listenerLeft', {
                        listenerId: socket.id,
                        listenerName: client.name
                    });
                    delete client.listeningTo;
                    client.type = 'unknown';
                }

                // 🔸 update everyone with new listener counts
                this.broadcastListenerCounts();
            });

            socket.on('discoverDevices', () => {
                // Send device list directly without logging
                socket.emit('deviceList', this.getDeviceList());
            });

            socket.on('connectToDevice', (targetDeviceId) => {
                const targetDevice = this.connectedClients.get(targetDeviceId);
                if (targetDevice && this.streamingClients.has(targetDeviceId)) {
                    // Successful connection
                    socket.emit('connectionResult', {
                        success: true,
                        device: {
                            id: targetDevice.id,
                            name: targetDevice.name,
                            ip: targetDevice.ip,
                            port: this.port
                        }
                    });
                    
                    // Notify the streaming device
                    this.io.to(targetDeviceId).emit('clientConnected', {
                        id: socket.id,
                        name: this.connectedClients.get(socket.id)?.name || 'Unknown Device'
                    });
                    
                } else {
                    socket.emit('connectionResult', {
                        success: false,
                        error: 'Device not found or not streaming'
                    });
                }
            });

            socket.on('manualConnect', (connectionInfo) => {
                console.log(`Manual connection attempt:`, connectionInfo);
                // For now, just simulate a connection
                socket.emit('connectionResult', {
                    success: false,
                    error: 'Manual connection not implemented yet'
                });
            });

            socket.on('requestRetransmission', (request) => {
                const { sourceId, startSeq, endSeq } = request;
                
                // Enhanced validation for high-quality retransmission
                if (!sourceId || typeof startSeq !== 'number' || typeof endSeq !== 'number') {
                    console.warn(`Invalid retransmission request from ${socket.id}`);
                    return;
                }
                
                if (!this.packetHistory.has(sourceId)) {
                    console.log(`No packet history for source ${sourceId}`);
                    return;
                }
                
                // Validate sequence numbers and range for ultra-high quality streaming
                const start = Math.floor(startSeq) >>> 0;
                const end = Math.floor(endSeq) >>> 0;
                const MAX_RETRANS_RANGE = 100; // Increased for high-quality audio
                
                if (end < start || (end - start) > MAX_RETRANS_RANGE) {
                    console.warn(`Invalid retransmission range from ${socket.id}: ${start}-${end}`);
                    return;
                }
                
                const history = this.packetHistory.get(sourceId);
                const missingPackets = [];
                let totalBytes = 0;
                const MAX_RETRANS_BYTES = 50 * 1024 * 1024; // 50MB limit for safety
                
                for (let seq = start; seq <= end; seq++) {
                    if (history.has(seq)) {
                        const packet = history.get(seq);
                        
                        // Check total size to prevent memory issues
                        totalBytes += packet.frameSize || 0;
                        if (totalBytes > MAX_RETRANS_BYTES) {
                            console.warn(`Retransmission size limit exceeded for ${sourceId}`);
                            break;
                        }
                        
                        missingPackets.push({
                            sourceId: sourceId,
                            timestamp: packet.timestamp,
                            seq: packet.seq,
                            channels: packet.channels,
                            sampleRate: packet.sampleRate,
                            bitDepth: packet.bitDepth,
                            quality: packet.quality,
                            audioFormat: 'float32',
                            isRetransmission: true,
                            data: packet.data
                        });
                    }
                }
                
                // Send missing packets back to requesting client with quality info
                if (missingPackets.length > 0) {
                    socket.emit('retransmittedPackets', missingPackets);
                    console.log(`Retransmitted ${missingPackets.length} high-quality packets for ${sourceId}, range ${start}-${end}, ${(totalBytes/1024).toFixed(1)}KB`);
                } else {
                    console.log(`No packets found for retransmission: ${sourceId}, range ${start}-${end}`);
                }
            });

            socket.on('disconnect', () => {
                console.log(`Client disconnected: ${socket.id}`);
                
                const client = this.connectedClients.get(socket.id);
                if (client) {
                    // If this client was listening to a stream, notify the streaming client about the listener leaving
                    if (client.listeningTo) {
                        this.io.to(client.listeningTo).emit('listenerLeft', {
                            listenerId: socket.id,
                            listenerName: client.name
                        });
                    }

                    // Notify other clients if this was a streaming client
                    if (this.streamingClients.has(socket.id)) {
                        socket.broadcast.emit('streamStopped', {
                            clientId: socket.id,
                            clientName: client.name
                        });
                    }
                    
                    // Notify connected clients
                    socket.broadcast.emit('clientDisconnected', {
                        id: socket.id,
                        name: client.name
                    });
                }
                
                this.connectedClients.delete(socket.id);
                this.streamingClients.delete(socket.id);
                this.audioDataRateLimit.delete(socket.id); // Clean up rate limiting data
                this.rateLimitWarnings.delete(socket.id); // Clean up warning tracking
                this.packetHistory.delete(socket.id); // Clean up packet history to prevent memory leaks
                this.broadcastDeviceList();

                // 🔸 update everyone with new listener counts
                this.broadcastListenerCounts();
            });
        });
    }

    getDeviceList() {
        return Array.from(this.connectedClients.values()).map(client => ({
            id: client.id,
            name: client.name,
            ip: client.ip,
            port: this.port,
            type: client.type,
            status: 'online',
            isStreaming: !!client.isStreaming,
            connectedAt: client.connectedAt
        }));
    }

    broadcastDeviceList() {
        const deviceList = this.getDeviceList();
        this.io.emit('deviceList', deviceList);
    }

    broadcastListenerCounts() {
        const counts = {};
        for (const client of this.connectedClients.values()) {
            if (client.listeningTo) {
                counts[client.listeningTo] = (counts[client.listeningTo] || 0) + 1;
            }
        }
        this.io.emit('listenerCounts', counts);
    }

    sanitizeDeviceName(deviceName) {
        if (!deviceName || typeof deviceName !== 'string') return null;
        
        // Remove potentially dangerous characters and limit length
        return deviceName
            .replace(/[<>"'&]/g, '') // Remove HTML/script chars
            .trim()
            .substring(0, 50); // Limit length
    }

    detectDeviceType(deviceName) {
        if (!deviceName) return 'unknown';
        
        const name = deviceName.toLowerCase();
        if (name.includes('windows') || name.includes('pc') || name.includes('desktop')) return 'desktop';
        if (name.includes('mac') || name.includes('macbook')) return 'desktop';
        if (name.includes('iphone') || name.includes('android') || name.includes('mobile')) return 'mobile';
        if (name.includes('ipad') || name.includes('tablet')) return 'tablet';
        
        return 'unknown';
    }

    getClientIP(socket) {
        return socket.handshake.address || 
               socket.conn.remoteAddress || 
               socket.request.connection.remoteAddress ||
               'unknown';
    }

    getLocalIP() {
        const interfaces = networkInterfaces();
        for (const name of Object.keys(interfaces)) {
            for (const iface of interfaces[name]) {
                if (iface.family === 'IPv4' && !iface.internal) {
                    return iface.address;
                }
            }
        }
        return '127.0.0.1';
    }

    startQualityMonitoring() {
        // Monitor audio quality and performance metrics
        setInterval(() => {
            for (const [sourceId, stats] of this.audioQualityStats.entries()) {
                if (stats.lastPacketTime && Date.now() - stats.lastPacketTime > 10000) {
                    // Clean up inactive sources
                    this.audioQualityStats.delete(sourceId);
                    continue;
                }
                
                // Log quality metrics for active high-quality streams
                if (stats.packetsReceived > 0 && stats.sampleRate >= 96000) {
                    const avgLatency = stats.totalLatency / stats.packetsReceived;
                    const packetLossRate = ((stats.expectedPackets - stats.packetsReceived) / stats.expectedPackets * 100).toFixed(2);
                    console.log(`🎯 HQ Audio Stats [${sourceId.substring(0,6)}]: ${stats.sampleRate}Hz/${stats.channels}ch, ${stats.packetsReceived} pkts, ${avgLatency.toFixed(1)}ms avg latency, ${packetLossRate}% loss`);
                }
            }
        }, this.qualityCheckInterval);
    }

    updateAudioQualityStats(sourceId, packet) {
        if (!this.audioQualityStats.has(sourceId)) {
            this.audioQualityStats.set(sourceId, {
                packetsReceived: 0,
                expectedPackets: 0,
                totalLatency: 0,
                sampleRate: 0,
                channels: 0,
                lastPacketTime: Date.now(),
                qualityLevel: 'unknown'
            });
        }
        
        const stats = this.audioQualityStats.get(sourceId);
        stats.packetsReceived++;
        stats.lastPacketTime = Date.now();
        stats.sampleRate = packet.sampleRate || stats.sampleRate;
        stats.channels = packet.channels || stats.channels;
        
        if (packet.timestamp) {
            const latency = Date.now() - packet.timestamp;
            stats.totalLatency += latency;
        }
        
        // Determine quality level
        if (stats.sampleRate >= 192000) stats.qualityLevel = 'ultra';
        else if (stats.sampleRate >= 96000) stats.qualityLevel = 'high';
        else if (stats.sampleRate >= 48000) stats.qualityLevel = 'standard';
        else stats.qualityLevel = 'basic';
    }

    start() {
        // Optimize Node.js for high-quality audio streaming
        if (process.env.NODE_ENV !== 'production') {
            // Development optimizations for audio quality testing
            process.setMaxListeners(100); // Allow more event listeners for multiple audio streams
        }
        
        this.server.listen(this.port, '0.0.0.0', () => {
            const localIP = this.getLocalIP();
            console.log('🎵 Ultra-High Quality Audio Transfer Server Started!');
            console.log('===============================================');
            console.log(`🌐 Server running on:`);
            console.log(`   • Local:    http://localhost:${this.port}`);
            console.log(`   • Network:  http://${localIP}:${this.port}`);
            console.log('===============================================');
            console.log(`📊 Status: Ready for ultra-high quality connections`);
            console.log(`🔊 Audio Features:`);
            console.log(`   • Sample Rates: 8kHz - 384kHz supported`);
            console.log(`   • Channels: Up to 32 channels (surround sound)`);
            console.log(`   • Bit Depth: 32-bit float (lossless)`);
            console.log(`   • Packet Rate: Up to 150 packets/sec`);
            console.log(`   • Buffer Size: 400 packet history`);
            console.log(`   • Quality Mode: Bit-perfect transmission`);
            console.log(`⚡ Technology: Node.js + Socket.IO + Ultra-optimized buffers`);
            console.log('===============================================');
        });

        // Graceful shutdown
        process.on('SIGINT', () => {
            console.log('\\n🛑 Shutting down server...');
            this.server.close(() => {
                console.log('✅ Server shutdown complete');
                process.exit(0);
            });
        });

        // Error handling
        this.server.on('error', (error) => {
            if (error.code === 'EADDRINUSE') {
                console.error(`❌ Port ${this.port} is already in use`);
                console.log('💡 Try using a different port: PORT=3002 npm start');
            } else {
                console.error('❌ Server error:', error);
            }
            process.exit(1);
        });
    }
}

// Create and start server
const server = new AudioTransferServer();
server.start();

export default AudioTransferServer;