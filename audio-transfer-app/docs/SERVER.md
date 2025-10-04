# Server-Side Documentation (server.js)

This document explains the structure and functionality of the `server.js` file, which manages the backend logic for the Audio Transfer application.

## `AudioTransferServer` Class

The server is built around the `AudioTransferServer` class, which encapsulates all server-related functionality.

### `constructor()`

```javascript
class AudioTransferServer {
    constructor() {
        this.app = express();
        this.server = createServer(this.app);
        this.io = new Server(this.server, {
            cors: {
                origin: true, // Allow all origins for local development
                methods: ["GET", "POST"],
            },
            transports: ['websocket', 'polling']
        });
        
        this.connectedClients = new Map();
        this.streamingClients = new Map();
        this.port = process.env.PORT || 3001;
        
        this.setupMiddleware();
        this.setupRoutes();
        this.setupSocketHandlers();
    }
```

**Explanation**:
The constructor initializes the Express app, creates an HTTP server, and sets up a Socket.IO server with CORS enabled to allow connections from any origin. It also initializes maps to track connected and streaming clients and sets up middleware, routes, and socket event handlers.

### `setupMiddleware()`

```javascript
    setupMiddleware() {
        this.app.use(cors());
        this.app.use(express.json());
        this.app.use(express.static(__dirname));
        this.app.use((req, res, next) => {
            console.log(`${new Date().toISOString()} - ${req.method} ${req.url}`);
            next();
        });
    }
```

**Explanation**:
This function configures the Express middleware. It enables CORS, a JSON parser for API requests, serves static files (like `index.html`, `app.js`), and adds a simple logger to print every incoming HTTP request to the console.

### `setupRoutes()`

```javascript
    setupRoutes() {
        this.app.get('/', (req, res) => {
            res.sendFile(join(__dirname, 'index.html'));
        });

        this.app.get('/api/devices', (req, res) => {
            // ... returns a list of connected devices
        });
    }
```

**Explanation**:
This function defines the HTTP routes. The main route `/` serves the `index.html` file. The `/api/devices` route provides a JSON endpoint for clients to get a list of all currently connected devices and their streaming status.

### `setupSocketHandlers()`

```javascript
    setupSocketHandlers() {
        this.io.on('connection', (socket) => {
            console.log(`Client connected: ${socket.id}`);
            
            // ... client registration and event handling
        });
    }
```

**Explanation**:
This is the core of the real-time server. It sets up a listener for new client connections. For each connected client, it registers them and sets up handlers for various events like starting/stopping streams, receiving audio data, and device discovery.

### `startStreaming` Event

```javascript
            socket.on('startStreaming', (data) => {
                console.log(`🎙️  ${socket.id} started streaming (${data.source}, ${data.quality})`);
                
                const client = this.connectedClients.get(socket.id);
                if (client) {
                    this.streamingClients.set(socket.id, {
                        ...client,
                        streamConfig: data
                    });
                
                    socket.broadcast.emit('streamStarted', { /* ... */ });
                    this.broadcastDeviceList();
                }
            });
```

**Explanation**:
When a client emits a `startStreaming` event, the server adds them to the `streamingClients` map and broadcasts a `streamStarted` event to all other clients. This allows the device list to be updated in real-time across all connected users.

### `audioData` Event

```javascript
            socket.on('audioData', (data) => {
                // ... rate limiting logic ...

                const streamInfo = this.streamingClients.get(socket.id);
                if (streamInfo) {
                    const payload = { /* ... audio data and metadata ... */ };
                    for (const [clientId, clientInfo] of this.connectedClients.entries()) {
                        if (clientInfo.listeningTo === socket.id) {
                            this.io.to(clientId).emit('audioStream', payload);
                        }
                    }
                }
            });
```

**Explanation**:
This event is fired frequently by a streaming client. The server receives the audio packet, performs rate limiting to prevent abuse, and then relays the audio data only to clients who have registered as listeners for that specific stream.

### `joinAsListener` Event

```javascript
            socket.on('joinAsListener', (sourceId) => {
                console.log(`${socket.id} joining as listener to ${sourceId}`);
                const client = this.connectedClients.get(socket.id);
                if (client) {
                    client.listeningTo = sourceId;
                }
                
                socket.emit('joinedAsListener', { /* ... */ });
                broadcastListenerCounts();
            });
```

**Explanation**:
When a client wants to listen to a stream, they emit `joinAsListener` with the ID of the streaming device. The server updates the client's state to record what they are listening to. This ensures they will receive audio packets from the correct source.

### `broadcastDeviceList()`

```javascript
    broadcastDeviceList() {
        const deviceList = this.getDeviceList();
        this.io.emit('deviceList', deviceList);
    }
```

**Explanation**:
This utility function is called whenever a client connects, disconnects, or changes their streaming status. It gathers a fresh list of all connected clients and broadcasts it to everyone, ensuring all users have an up-to-date view of available devices.

### `start()`

```javascript
    start() {
        this.server.listen(this.port, '0.0.0.0', () => {
            const localIP = this.getLocalIP();
            console.log('🎵 Audio Transfer Server Started!');
            // ... logs server URLs to the console
        });
    }
```

**Explanation**:
This function starts the HTTP server and makes it listen on all network interfaces (`0.0.0.0`) on the specified port. It logs helpful URLs to the console, including the local network address, making it easy for users on the same network to connect.

---

## Server Flow Diagram

```
┌───────────────────┐      ┌───────────────────┐      ┌───────────────────┐
│   Server Starts   │─────▶│  Express &        │─────▶│  Socket.IO        │
│                   │      │  HTTP Server Init │      │  Initialization   │
└───────────────────┘      └───────────────────┘      └───────────────────┘
         │                        │                        │
         ▼                        ▼                        ▼
┌───────────────────┐      ┌───────────────────┐      ┌───────────────────┐
│  Listens on Port  │      │  Static Files     │      │  Waits for        │
│  (e.g., 3001)     │◀─────│  Served (HTML/JS) │◀─────│  Connections      │
└───────────────────┘      └───────────────────┘      └───────────────────┘

CLIENT CONNECTION FLOW:
┌───────────────────┐      ┌───────────────────┐      ┌───────────────────┐
│  Client Connects  │─────▶│  'connection'     │─────▶│  Register Client  │
│  (Socket.IO)      │      │  Event Fired      │      │  (add to Map)     │
└───────────────────┘      └───────────────────┘      └───────────────────┘
         │
         ▼
┌───────────────────┐      ┌───────────────────┐
│  Broadcast Updated│◀─────│  Client Emits     │
│  Device List      │      │  'discoverDevices'│
└───────────────────┘      └───────────────────┘

AUDIO RELAY FLOW:
┌───────────────────┐      ┌───────────────────┐      ┌───────────────────┐
│  Streaming Client │─────▶│  'audioData'      │─────▶│  Server Receives  │
│  Sends Packet     │      │  Event            │      │  Packet           │
└───────────────────┘      └───────────────────┘      └───────────────────┘
         │                        │                        │
         ▼                        ▼                        ▼
┌───────────────────┐      ┌───────────────────┐      ┌───────────────────┐
│  Finds All        │─────▶│  Forwards Packet  │─────▶│  Listening Client │
│  Matching Listeners│      │  via 'audioStream'│      │  Receives Packet  │
└───────────────────┘      └───────────────────┘      └───────────────────┘
```
**Explanation**:
This diagram shows the server's lifecycle and primary data flows. It covers the initialization process, how new clients are handled, and the core logic for relaying audio packets from a streaming client to one or more listening clients.