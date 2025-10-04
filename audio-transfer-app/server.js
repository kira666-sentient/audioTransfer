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
                    ["http://localhost:3001", "http://127.0.0.1:3001"],
                methods: ["GET", "POST"],
                credentials: false
            }
        });
        
        this.connectedClients = new Map();
        this.streamingClients = new Map();
        this.port = process.env.PORT || 3001;
        
        // Rate limiting for audio data
        this.audioDataRateLimit = new Map();
        this.maxAudioPacketsPerSecond = 60; // Increased for real-time audio quality (50 + buffer)
        this.rateLimitWarnings = new Map(); // Track warnings sent to clients
        
        this.setupMiddleware();
        this.setupRoutes();
        this.setupSocketHandlers();
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
            
            // helper to broadcast listener count for each streamer
            const broadcastListenerCounts = () => {
                const counts = {};
                for (const client of this.connectedClients.values()) {
                    if (client.listeningTo) {
                        counts[client.listeningTo] = (counts[client.listeningTo] || 0) + 1;
                    }
                }
                this.io.emit('listenerCounts', counts);
            };

            // Register client
            const clientInfo = {
                id: socket.id,
                name: `Device-${socket.id.substring(0, 6)}`,
                ip: this.getClientIP(socket),
                type: 'unknown',
                connectedAt: new Date()
            };
            
            this.connectedClients.set(socket.id, clientInfo);
            this.broadcastDeviceList();

            // Handle streaming events
            socket.on('startStreaming', (data) => {
                // Validate streaming configuration
                if (!data || typeof data !== 'object') {
                    console.warn(`Invalid streaming config from ${socket.id}`);
                    return;
                }
                
                const validSources = ['microphone', 'system', 'file'];
                const validQualities = ['low', 'medium', 'high', 'ultra'];
                
                if (!validSources.includes(data.source) || !validQualities.includes(data.quality)) {
                    console.warn(`Invalid streaming parameters from ${socket.id}`);
                    return;
                }
                
                console.log(`🎙️  ${socket.id} started streaming (${data.source}, ${data.quality})`);
                
                // Update client info
                const client = this.connectedClients.get(socket.id);
                if (client) {
                    this.streamingClients.set(socket.id, {
                    ...client,
                    streamConfig: data
                });
                
                // Notify other clients
                socket.broadcast.emit('streamStarted', {
                    clientId: socket.id,
                    clientName: client?.name,
                    config: {
                        source: data.source,
                        quality: data.quality
                    }
                });
                
                this.broadcastDeviceList();
                }
            });

            socket.on('stopStreaming', () => {
                console.log(`Client ${socket.id} stopped streaming`);

                const client = this.connectedClients.get(socket.id);
                if (client) {
                    client.isStreaming = false;
                    delete client.streamConfig;
                }

                this.streamingClients.delete(socket.id);

                // Notify other clients
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
                if (!data || data.data == null) {
                    return; // Silently drop invalid data instead of logging
                }
                let normalizedArrayBuffer = null;
                try {
                    const payload = data.data;
                    if (payload instanceof ArrayBuffer) {
                        normalizedArrayBuffer = payload;
                    } else if (Array.isArray(payload)) {
                        // array of numbers -> Float32Array -> ArrayBuffer
                        const f32 = new Float32Array(payload);
                        normalizedArrayBuffer = f32.buffer;
                    } else if (Buffer.isBuffer(payload)) {
                        // Node Buffer -> slice underlying ArrayBuffer to exact view
                        normalizedArrayBuffer = payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.byteLength);
                    } else if (ArrayBuffer.isView(payload)) {
                        // TypedArray/DataView -> normalize to ArrayBuffer slice
                        normalizedArrayBuffer = payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.byteLength);
                    } else {
                        return; // unsupported type
                    }
                } catch (e) {
                    return;
                }
                
                // Relay audio data to all listening clients with improved metadata
                const streamInfo = this.streamingClients.get(socket.id);
                if (streamInfo) {
                    // Send audioStream only to clients listening to this source
                    const payload = {
                        sourceId: socket.id,
                        sourceName: this.connectedClients.get(socket.id)?.name,
                        timestamp: data.timestamp || Date.now(),
                        quality: streamInfo.streamConfig?.quality,
                        channel: data.channel || 0,
                        seq: data.seq,
                        sampleIndex: data.sampleIndex,
                        frameSamples: data.frameSamples,
                        channels: data.channels || 1,
                        sampleRate: data.sampleRate || 48000,
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
                broadcastListenerCounts();
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
                broadcastListenerCounts();
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

            socket.on('disconnect', () => {
                console.log(`Client disconnected: ${socket.id}`);
                
                const client = this.connectedClients.get(socket.id);
                if (client) {
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
                this.broadcastDeviceList();

                // 🔸 update everyone with new listener counts
                broadcastListenerCounts();
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
            isStreaming: this.streamingClients.has(client.id),
            connectedAt: client.connectedAt
        }));
    }

    broadcastDeviceList() {
        const deviceList = this.getDeviceList();
        this.io.emit('deviceList', deviceList);
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

    start() {
        this.server.listen(this.port, () => {
            const localIP = this.getLocalIP();
            console.log('🎵 Audio Transfer Server Started!');
            console.log('=====================================');
            console.log(`🌐 Server running on:`);
            console.log(`   • Local:    http://localhost:${this.port}`);
            console.log(`   • Network:  http://${localIP}:${this.port}`);
            console.log('=====================================');
            console.log(`📊 Status: Ready for connections`);
            console.log(`🔊 Features: Audio streaming, device discovery`);
            console.log(`⚡ Technology: Node.js + Socket.IO + Bootstrap`);
            console.log('=====================================');
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