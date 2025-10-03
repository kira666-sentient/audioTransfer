# Server.js Documentation

## Overview

The `server.js` file contains the **AudioTransferServer** class, which serves as the backbone of the audio streaming application. It handles WebSocket connections, audio stream relay, device discovery, and real-time communication between multiple clients.

## Class: AudioTransferServer

### Constructor

```javascript
constructor()
```

**Purpose**: Initializes the server with all necessary components and configurations.

**Initialization Flow**:
1. Creates Express.js application instance
2. Sets up HTTP server with Express
3. Initializes Socket.IO server with CORS configuration
4. Creates data structures for client management
5. Sets default port (3001 or from environment)
6. Calls setup methods for middleware, routes, and Socket.IO handlers

**Data Structures**:
- `connectedClients`: Map storing all connected client information
- `streamingClients`: Map tracking clients that are actively streaming audio
- `port`: Server port number

---

## Middleware Setup

### setupMiddleware()

**Purpose**: Configures Express.js middleware for the application.

**Middleware Components**:

1. **CORS (Cross-Origin Resource Sharing)**
   ```javascript
   this.app.use(cors());
   ```
   - Enables cross-origin requests
   - Allows frontend to communicate with backend from different ports

2. **JSON Parser**
   ```javascript
   this.app.use(express.json());
   ```
   - Parses incoming JSON requests
   - Makes request body available as `req.body`

3. **Static File Serving**
   ```javascript
   this.app.use(express.static(__dirname));
   ```
   - Serves static files (HTML, CSS, JS) from the current directory
   - Automatically handles file requests

4. **Request Logging**
   ```javascript
   this.app.use((req, res, next) => {
       console.log(`${new Date().toISOString()} - ${req.method} ${req.url}`);
       next();
   });
   ```
   - Logs all incoming HTTP requests with timestamps
   - Useful for debugging and monitoring

---

## Route Definitions

### setupRoutes()

**Purpose**: Defines all HTTP endpoints and their handlers.

#### Main Routes

1. **Root Route (`/`)**
   ```javascript
   this.app.get('/', (req, res) => {
       res.sendFile(join(__dirname, 'index.html'));
   });
   ```
   - Serves the main application HTML file
   - Entry point for the web application

2. **Status API (`/api/status`)**
   ```javascript
   this.app.get('/api/status', (req, res) => {
       res.json({
           status: 'running',
           connectedClients: this.connectedClients.size,
           streamingClients: this.streamingClients.size,
           serverTime: new Date().toISOString(),
           localIP: this.getLocalIP()
       });
   });
   ```
   - **Purpose**: Provides real-time server statistics
   - **Returns**: Server status, client counts, timestamp, and local IP
   - **Use Case**: Health monitoring and debugging

3. **Devices API (`/api/devices`)**
   ```javascript
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
   ```
   - **Purpose**: Returns list of all connected devices
   - **Data Structure**: Array of device objects with metadata
   - **Use Case**: Device discovery and management

4. **Health Check (`/health`)**
   ```javascript
   this.app.get('/health', (req, res) => {
       res.json({ status: 'healthy', timestamp: new Date().toISOString() });
   });
   ```
   - **Purpose**: Simple health check endpoint
   - **Use Case**: Load balancer health checks, monitoring

---

## Socket.IO Event Handlers

### setupSocketHandlers()

**Purpose**: Manages real-time WebSocket communication between clients.

#### Connection Events

1. **Client Connection**
   ```javascript
   this.io.on('connection', (socket) => {
       console.log(`Client connected: ${socket.id}`);
       
       const clientInfo = {
           id: socket.id,
           name: `Device-${socket.id.substring(0, 6)}`,
           ip: this.getClientIP(socket),
           type: 'unknown',
           connectedAt: new Date()
       };
       
       this.connectedClients.set(socket.id, clientInfo);
       this.broadcastDeviceList();
   });
   ```
   - **Flow**: Client connects → Generate client info → Store in Map → Broadcast updated device list
   - **Client Info**: Unique ID, auto-generated name, IP address, device type, connection timestamp

#### Audio Streaming Events

2. **Start Streaming**
   ```javascript
   socket.on('startStreaming', (data) => {
       // Update client info with streaming configuration
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
       
       // Add to streaming clients
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
   });
   ```
   - **Purpose**: Handles when a client starts streaming audio
   - **Flow**: Receive config → Update client info → Add to streaming map → Broadcast to others
   - **Data**: Audio source, quality settings, device name

3. **Stop Streaming**
   ```javascript
   socket.on('stopStreaming', () => {
       const client = this.connectedClients.get(socket.id);
       if (client) {
           client.isStreaming = false;
           delete client.streamConfig;
       }
       
       this.streamingClients.delete(socket.id);
       
       socket.broadcast.emit('streamStopped', {
           clientId: socket.id,
           clientName: client?.name
       });
   });
   ```
   - **Purpose**: Handles when streaming stops
   - **Flow**: Update client info → Remove from streaming map → Notify others

4. **Audio Data Relay**
   ```javascript
   socket.on('audioData', (data) => {
       const streamInfo = this.streamingClients.get(socket.id);
       if (streamInfo) {
           socket.broadcast.emit('audioStream', {
               sourceId: socket.id,
               sourceName: this.connectedClients.get(socket.id)?.name,
               timestamp: Date.now(),
               quality: streamInfo.streamConfig?.quality,
               ...data
           });
       }
   });
   ```
   - **Purpose**: Relays audio data from streaming clients to listeners
   - **Enhancement**: Adds metadata (timestamp, source info, quality)
   - **Performance**: Uses `broadcast` to avoid sending back to sender

#### Listener Management Events

5. **Join as Listener**
   ```javascript
   socket.on('joinAsListener', (sourceId) => {
       const client = this.connectedClients.get(socket.id);
       if (client) {
           client.type = 'listener';
           client.listeningTo = sourceId;
       }
       
       // Notify streaming client
       if (this.streamingClients.has(sourceId)) {
           this.io.to(sourceId).emit('listenerJoined', {
               listenerId: socket.id,
               listenerName: client?.name
           });
       }
   });
   ```
   - **Purpose**: Manages clients joining as audio listeners
   - **Flow**: Update client type → Set listening target → Notify streamer

6. **Leave as Listener**
   ```javascript
   socket.on('leaveAsListener', () => {
       const client = this.connectedClients.get(socket.id);
       if (client && client.listeningTo) {
           this.io.to(client.listeningTo).emit('listenerLeft', {
               listenerId: socket.id,
               listenerName: client.name
           });
           
           delete client.listeningTo;
           client.type = 'unknown';
       }
   });
   ```
   - **Purpose**: Handles listener disconnection
   - **Flow**: Notify streamer → Clean up client info

#### Device Discovery Events

7. **Device Discovery**
   ```javascript
   socket.on('discoverDevices', () => {
       socket.emit('deviceList', this.getDeviceList());
   });
   ```
   - **Purpose**: Responds to device discovery requests
   - **Response**: Current list of all connected devices

8. **Device Connection**
   ```javascript
   socket.on('connectToDevice', (targetDeviceId) => {
       const targetDevice = this.connectedClients.get(targetDeviceId);
       if (targetDevice && this.streamingClients.has(targetDeviceId)) {
           socket.emit('connectionResult', {
               success: true,
               device: { /* device info */ }
           });
       } else {
           socket.emit('connectionResult', {
               success: false,
               error: 'Device not found or not streaming'
           });
       }
   });
   ```
   - **Purpose**: Handles connection attempts between devices
   - **Validation**: Checks if target device exists and is streaming

#### Disconnection Handling

9. **Client Disconnection**
   ```javascript
   socket.on('disconnect', () => {
       const client = this.connectedClients.get(socket.id);
       
       // Notify about streaming stop if applicable
       if (this.streamingClients.has(socket.id)) {
           socket.broadcast.emit('streamStopped', {
               clientId: socket.id,
               clientName: client.name
           });
       }
       
       // Clean up data structures
       this.connectedClients.delete(socket.id);
       this.streamingClients.delete(socket.id);
       this.broadcastDeviceList();
   });
   ```
   - **Purpose**: Cleans up when clients disconnect
   - **Flow**: Notify others → Remove from all maps → Broadcast updated list

---

## Utility Methods

### getDeviceList()

```javascript
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
```
- **Purpose**: Converts client Map to array format
- **Enhancement**: Adds streaming status and metadata

### broadcastDeviceList()

```javascript
broadcastDeviceList() {
    const deviceList = this.getDeviceList();
    this.io.emit('deviceList', deviceList);
}
```
- **Purpose**: Sends updated device list to all connected clients
- **Use Case**: Called after any device state change

### detectDeviceType(deviceName)

```javascript
detectDeviceType(deviceName) {
    if (!deviceName) return 'unknown';
    
    const name = deviceName.toLowerCase();
    if (name.includes('windows') || name.includes('pc')) return 'desktop';
    if (name.includes('mac') || name.includes('macbook')) return 'desktop';
    if (name.includes('iphone') || name.includes('android')) return 'mobile';
    if (name.includes('ipad') || name.includes('tablet')) return 'tablet';
    
    return 'unknown';
}
```
- **Purpose**: Auto-detects device type from device name
- **Categories**: desktop, mobile, tablet, unknown
- **Use Case**: UI iconography and device classification

### getClientIP(socket)

```javascript
getClientIP(socket) {
    return socket.handshake.address || 
           socket.conn.remoteAddress || 
           socket.request.connection.remoteAddress ||
           'unknown';
}
```
- **Purpose**: Extracts client IP address from socket connection
- **Fallback Chain**: Tries multiple socket properties for compatibility

### getLocalIP()

```javascript
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
```
- **Purpose**: Finds the local network IP address
- **Logic**: Iterates through network interfaces, returns first non-internal IPv4
- **Fallback**: localhost if no network interface found

---

## Server Lifecycle

### start()

```javascript
start() {
    this.server.listen(this.port, () => {
        const localIP = this.getLocalIP();
        console.log('🎵 Audio Transfer Server Started!');
        console.log(`🌐 Server running on:`);
        console.log(`   • Local:    http://localhost:${this.port}`);
        console.log(`   • Network:  http://${localIP}:${this.port}`);
    });
}
```

**Startup Flow**:
1. Bind server to port
2. Display startup banner with connection URLs
3. Show server capabilities and technology stack

**Error Handling**:
- **EADDRINUSE**: Port already in use - suggests alternative
- **General Errors**: Logs error and exits gracefully

**Graceful Shutdown**:
```javascript
process.on('SIGINT', () => {
    console.log('\\n🛑 Shutting down server...');
    this.server.close(() => {
        console.log('✅ Server shutdown complete');
        process.exit(0);
    });
});
```

---

## Data Flow Diagrams

### Audio Streaming Flow
```
Client A (Streamer)          Server                    Client B (Listener)
     |                        |                            |
     |-- startStreaming -->   |                            |
     |                        |-- streamStarted --------->|
     |-- audioData --------->  |                            |
     |                        |-- audioStream ----------->|
     |                        |                            |
```

### Device Discovery Flow
```
Client                      Server                     All Clients
   |                         |                            |
   |-- discoverDevices -->   |                            |
   |<-- deviceList --------  |                            |
   |                         |-- deviceList ------------->|
   |                         |   (broadcast updates)      |
```

---

## Performance Considerations

1. **Memory Management**
   - Uses Map data structures for O(1) lookups
   - Automatic cleanup on client disconnect
   - No audio data persistence (streams in real-time)

2. **Network Efficiency**
   - Uses Socket.IO's broadcast to avoid sending data back to sender
   - Minimal metadata overhead in audio packets
   - Efficient JSON serialization for control messages

3. **Scalability**
   - Stateless design (no file system dependencies)
   - Horizontal scaling possible with load balancer
   - Real-time metrics available via `/api/status`

4. **Error Resilience**
   - Graceful handling of client disconnections
   - Automatic cleanup of orphaned data
   - Fallback mechanisms for IP detection

---

## Security Considerations

1. **CORS Configuration**
   - Currently allows all origins (`*`)
   - Should be restricted in production

2. **Input Validation**
   - Device names and configuration validated
   - Socket event data checked before processing

3. **Rate Limiting**
   - Consider implementing for production use
   - Audio data streaming could be rate-limited

4. **Network Security**
   - Server binds to all interfaces (0.0.0.0)
   - Consider restricting to specific network interfaces in production

---

This server provides a robust foundation for real-time audio streaming with device discovery, multiple client support, and comprehensive event handling.