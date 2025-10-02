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
                origin: "*",
                methods: ["GET", "POST"]
            }
        });
        
        this.connectedClients = new Map();
        this.streamingClients = new Map();
        this.port = process.env.PORT || 3001;
        
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
                console.log(`Client ${socket.id} started streaming:`, data);
                
                // Update client info
                const client = this.connectedClients.get(socket.id);
                if (client) {
                    client.name = data.deviceName || client.name;
                    client.type = this.detectDeviceType(data.deviceName);
                    client.isStreaming = true;
                    client.streamConfig = {
                        source: data.source,
                        quality: data.quality,
                        startedAt: new Date()
                    };
                }
                
                this.streamingClients.set(socket.id, {
                    ...clientInfo,
                    streamConfig: data
                });
                
                // Notify other clients
                socket.broadcast.emit('streamStarted', {
                    clientId: socket.id,
                    clientName: client.name,
                    config: data
                });
                
                this.broadcastDeviceList();
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
                // Relay audio data to connected clients
                socket.broadcast.emit('audioStream', {
                    sourceId: socket.id,
                    ...data
                });
            });

            socket.on('discoverDevices', () => {
                console.log(`Device discovery requested by ${socket.id}`);
                socket.emit('deviceList', this.getDeviceList());
            });

            socket.on('connectToDevice', (targetDeviceId) => {
                console.log(`${socket.id} attempting to connect to ${targetDeviceId}`);
                
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
                this.broadcastDeviceList();
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