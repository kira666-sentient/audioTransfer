import { useState, useEffect } from 'react';
import { Search, Volume2, Wifi, RefreshCw, Play, Pause, VolumeX, Headphones, Speaker } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import toast from 'react-hot-toast';
import { useAudio } from '../context/AudioContext';

interface DiscoveredDevice {
  id: string;
  name: string;
  ip: string;
  port: number;
  quality: string;
}

const PlayTab = () => {
  const { state, dispatch } = useAudio();
  const [discoveredDevices, setDiscoveredDevices] = useState<DiscoveredDevice[]>([]);
  const [isScanning, setIsScanning] = useState(false);
  const [manualIP, setManualIP] = useState('');
  const [selectedDevice, setSelectedDevice] = useState<DiscoveredDevice | null>(null);

  // Mock discovered devices for demo
  const mockDevices: DiscoveredDevice[] = [
    { id: '1', name: 'Living Room Speaker', ip: '192.168.1.100', port: 3001, quality: 'High' },
    { id: '2', name: 'John\'s Laptop', ip: '192.168.1.101', port: 3001, quality: 'Medium' },
    { id: '3', name: 'Kitchen Radio', ip: '192.168.1.102', port: 3001, quality: 'Ultra' },
  ];

  const scanForDevices = async () => {
    setIsScanning(true);
    toast.loading('Scanning for devices...', { id: 'scanning' });
    
    // Simulate device discovery
    setTimeout(() => {
      setDiscoveredDevices(mockDevices);
      setIsScanning(false);
      toast.dismiss('scanning');
      toast.success(`Found ${mockDevices.length} devices!`, {
        icon: '📡',
        duration: 3000,
      });
    }, 2000);

    // In real implementation, this would:
    // 1. Scan local network for devices running the audio server
    // 2. Use mDNS/Bonjour for service discovery
    // 3. Send broadcast packets to discover services
  };

  const connectToDevice = async (device: DiscoveredDevice) => {
    const connectingToast = toast.loading(`Connecting to ${device.name}...`, {
      icon: '🔗',
    });

    try {
      setSelectedDevice(device);
      dispatch({ type: 'SET_CONNECTION_STATUS', payload: 'connecting' });
      dispatch({ type: 'SET_SERVER_URL', payload: `http://${device.ip}:${device.port}` });

      // Simulate connection
      setTimeout(() => {
        dispatch({ type: 'SET_CONNECTION_STATUS', payload: 'connected' });
        toast.dismiss(connectingToast);
        toast.success(`Connected to ${device.name}!`, {
          icon: '🎵',
          duration: 3000,
        });
        console.log('Connected to device:', device.name);
      }, 1500);

      // In real implementation, this would:
      // 1. Establish WebRTC connection
      // 2. Set up audio stream receiving
      // 3. Handle connection errors
      
    } catch (error) {
      console.error('Connection failed:', error);
      dispatch({ type: 'SET_CONNECTION_STATUS', payload: 'disconnected' });
      toast.dismiss(connectingToast);
      toast.error(`Failed to connect to ${device.name}`, {
        icon: '❌',
        duration: 4000,
      });
    }
  };

  const connectManually = () => {
    if (!manualIP.trim()) return;
    
    const manualDevice: DiscoveredDevice = {
      id: 'manual',
      name: 'Manual Connection',
      ip: manualIP,
      port: 3001,
      quality: 'Unknown'
    };
    
    connectToDevice(manualDevice);
  };

  const startPlaying = () => {
    dispatch({ type: 'START_PLAYING' });
    // In real implementation, start receiving and playing audio stream
  };

  const stopPlaying = () => {
    dispatch({ type: 'STOP_PLAYING' });
    // In real implementation, stop audio stream
  };

  const disconnect = () => {
    dispatch({ type: 'STOP_PLAYING' });
    dispatch({ type: 'SET_CONNECTION_STATUS', payload: 'disconnected' });
    setSelectedDevice(null);
    dispatch({ type: 'SET_SERVER_URL', payload: '' });
  };

  useEffect(() => {
    // Auto-scan on component mount
    scanForDevices();
  }, []);

  if (state.connectionStatus === 'connected' && selectedDevice) {
    return (
      <motion.div 
        className="space-y-8 w-full max-w-2xl mx-auto px-2 sm:px-6 md:px-8"
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 0.6 }}
      >
        {/* Header */}
        <motion.div 
          className="text-center"
          initial={{ opacity: 0, y: -20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.1 }}
        >
          <motion.h2 
            className="text-2xl sm:text-3xl font-bold bg-gradient-to-r from-white to-gray-200 bg-clip-text text-transparent mb-3"
            whileHover={{ scale: 1.02 }}
          >
            🎧 Now Playing
          </motion.h2>
          <p className="text-slate-300 text-base sm:text-lg">Connected to {selectedDevice.name}</p>
        </motion.div>

        {/* Connected Device Info */}
        <motion.div 
          className="bg-gradient-to-r from-violet-500/20 to-purple-500/20 backdrop-blur-xl rounded-2xl sm:rounded-3xl p-4 sm:p-8 border border-white/20"
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.2 }}
          whileHover={{ scale: 1.02, y: -2 }}
        >
          <div className="flex flex-col sm:flex-row items-center justify-between mb-6 gap-4">
            <div className="flex items-center space-x-4">
              <motion.div
                className="bg-gradient-to-r from-violet-400 to-purple-400 p-3 rounded-2xl"
                animate={{ rotate: [0, 5, -5, 0] }}
                transition={{ duration: 4, repeat: Infinity }}
              >
                <Speaker className="text-white" size={28} />
              </motion.div>
              <div>
                <h3 className="text-white font-bold text-lg sm:text-xl">{selectedDevice.name}</h3>
                <p className="text-slate-300 font-mono text-sm">{selectedDevice.ip}:{selectedDevice.port}</p>
                <p className="text-slate-300 text-xs sm:text-sm">Quality: {selectedDevice.quality}</p>
              </div>
            </div>
            <motion.div
              className="flex items-center space-x-2 bg-emerald-500/20 text-emerald-400 px-4 py-2 rounded-full border border-emerald-400/30"
              animate={{ scale: [1, 1.05, 1] }}
              transition={{ duration: 2, repeat: Infinity }}
            >
              <Wifi size={20} />
              <span className="font-medium">Connected</span>
            </motion.div>
          </div>

          {/* Playback Controls */}
          <motion.div 
            className="flex items-center justify-center space-x-6 mb-8"
            initial={{ opacity: 0, scale: 0.8 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ delay: 0.4 }}
          >
            <AnimatePresence mode="wait">
              {!state.isPlaying ? (
                <motion.button
                  key="play"
                  onClick={startPlaying}
                  className="bg-gradient-to-r from-emerald-500 to-cyan-500 hover:from-emerald-600 hover:to-cyan-600 text-white p-6 rounded-full shadow-2xl"
                  initial={{ opacity: 0, scale: 0.8 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.8 }}
                  whileHover={{ scale: 1.1 }}
                  whileTap={{ scale: 0.95 }}
                >
                  <Play size={32} />
                </motion.button>
              ) : (
                <motion.button
                  key="pause"
                  onClick={stopPlaying}
                  className="bg-gradient-to-r from-yellow-500 to-orange-500 hover:from-yellow-600 hover:to-orange-600 text-white p-6 rounded-full shadow-2xl"
                  initial={{ opacity: 0, scale: 0.8 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.8 }}
                  whileHover={{ scale: 1.1 }}
                  whileTap={{ scale: 0.95 }}
                >
                  <Pause size={32} />
                </motion.button>
              )}
            </AnimatePresence>
          </motion.div>

          {/* Volume Control */}
          <motion.div 
            className="space-y-4"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.5 }}
          >
            <div className="flex items-center justify-between">
              <div className="flex items-center space-x-3 text-white">
                <motion.div
                  animate={{ scale: state.volume > 0 ? [1, 1.2, 1] : 1 }}
                  transition={{ duration: 1, repeat: state.volume > 0 ? Infinity : 0 }}
                >
                  {state.volume === 0 ? <VolumeX size={24} /> : <Volume2 size={24} />}
                </motion.div>
                <span className="font-semibold text-base sm:text-lg">Volume</span>
              </div>
              <motion.span 
                className="text-white font-bold text-base sm:text-xl bg-white/10 px-4 py-2 rounded-xl"
                key={state.volume}
                initial={{ scale: 1.2 }}
                animate={{ scale: 1 }}
                transition={{ type: "spring", stiffness: 300 }}
              >
                {state.volume}%
              </motion.span>
            </div>
            <div className="relative">
              <input
                type="range"
                min="0"
                max="100"
                value={state.volume}
                onChange={(e) => dispatch({ type: 'SET_VOLUME', payload: parseInt(e.target.value) })}
                className="w-full h-3 bg-white/20 rounded-full appearance-none cursor-pointer slider"
                style={{
                  background: `linear-gradient(to right, #10b981 0%, #06b6d4 ${state.volume}%, rgba(255,255,255,0.2) ${state.volume}%, rgba(255,255,255,0.2) 100%)`
                }}
              />
            </div>
          </motion.div>

          {/* Audio Visualizer */}
          {state.isPlaying && (
            <motion.div 
              className="flex items-end justify-center space-x-1 h-12 mt-6"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ delay: 0.6 }}
            >
              {[...Array(20)].map((_, i) => (
                <motion.div
                  key={i}
                  className="bg-gradient-to-t from-violet-500 to-purple-400 w-1 rounded-full"
                  animate={{
                    height: [4, Math.random() * 30 + 10, 4],
                  }}
                  transition={{
                    duration: 0.4 + Math.random() * 0.4,
                    repeat: Infinity,
                    ease: "easeInOut",
                    delay: i * 0.05,
                  }}
                />
              ))}
            </motion.div>
          )}
        </motion.div>

        {/* Disconnect Button */}
        <motion.div 
          className="text-center"
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.3 }}
        >
          <motion.button
            onClick={disconnect}
            className="bg-gradient-to-r from-red-500 to-pink-500 hover:from-red-600 hover:to-pink-600 text-white px-6 sm:px-8 py-3 sm:py-4 rounded-2xl font-semibold text-base sm:text-lg shadow-2xl"
            whileHover={{ scale: 1.05, y: -2 }}
            whileTap={{ scale: 0.95 }}
          >
            Disconnect
          </motion.button>
        </motion.div>
      </motion.div>
    );
  }

  return (
    <motion.div 
      className="space-y-6 w-full max-w-3xl mx-auto"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.6 }}
    >
      {/* Header */}
      <motion.div 
        className="text-center"
        initial={{ opacity: 0, y: -20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.6 }}
      >
        <motion.h2 
          className="text-2xl sm:text-3xl font-bold bg-gradient-to-r from-white to-gray-200 bg-clip-text text-transparent mb-3"
          whileHover={{ scale: 1.02 }}
        >
          📡 Find Audio Streams
        </motion.h2>
        <p className="text-slate-300 text-base sm:text-lg">Discover and connect to audio streams on your network</p>
      </motion.div>

      {/* Scan Controls */}
      <motion.div 
        className="flex justify-center"
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.1, duration: 0.5 }}
      >
        <motion.button
          onClick={scanForDevices}
          disabled={isScanning}
          className={`px-6 sm:px-8 py-3 sm:py-4 rounded-2xl font-semibold text-base sm:text-lg flex items-center space-x-3 shadow-2xl transition-all ${
            isScanning 
              ? 'bg-gradient-to-r from-blue-400 to-blue-500 cursor-not-allowed' 
              : 'bg-gradient-to-r from-blue-500 to-indigo-500 hover:from-blue-600 hover:to-indigo-600'
          } text-white`}
          whileHover={!isScanning ? { scale: 1.05, y: -2 } : {}}
          whileTap={!isScanning ? { scale: 0.95 } : {}}
        >
          <motion.div
            animate={isScanning ? { rotate: 360 } : {}}
            transition={isScanning ? { duration: 1, repeat: Infinity, ease: "linear" } : {}}
          >
            <RefreshCw size={24} />
          </motion.div>
          <span>{isScanning ? 'Scanning...' : 'Scan for Devices'}</span>
        </motion.button>
      </motion.div>

      {/* Manual Connection */}
      <motion.div 
        className="bg-gradient-to-r from-emerald-500/20 to-cyan-500/20 backdrop-blur-xl rounded-2xl p-4 sm:p-6 border border-white/20"
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.2, duration: 0.5 }}
        whileHover={{ scale: 1.02, y: -2 }}
      >
        <div className="flex items-center space-x-2 mb-4">
          <motion.div
            animate={{ rotate: [0, 10, -10, 0] }}
            transition={{ duration: 3, repeat: Infinity }}
          >
            <Search className="text-emerald-400" size={20} />
          </motion.div>
          <h3 className="text-white font-semibold text-base sm:text-xl">Manual Connection</h3>
        </div>
        <div className="flex flex-col sm:flex-row gap-3">
          <motion.input
            type="text"
            placeholder="Enter IP address (e.g., 192.168.1.100)"
            value={manualIP}
            onChange={(e) => setManualIP(e.target.value)}
            className="flex-1 px-4 py-3 rounded-xl bg-white/10 text-white placeholder-slate-400 border border-white/20 focus:border-emerald-400 focus:outline-none transition-all"
            whileFocus={{ scale: 1.02 }}
          />
          <motion.button
            onClick={connectManually}
            className="bg-gradient-to-r from-emerald-500 to-cyan-500 hover:from-emerald-600 hover:to-cyan-600 text-white px-6 py-3 rounded-xl font-semibold transition-all"
            whileHover={{ scale: 1.05 }}
            whileTap={{ scale: 0.95 }}
          >
            Connect
          </motion.button>
        </div>
      </motion.div>

      {/* Discovered Devices */}
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.3, duration: 0.5 }}
      >
        <div className="flex items-center space-x-2 mb-6">
          <motion.div
            animate={{ scale: [1, 1.2, 1] }}
            transition={{ duration: 2, repeat: Infinity }}
          >
            <Headphones className="text-purple-400" size={20} />
          </motion.div>
          <h3 className="text-white font-semibold text-base sm:text-xl">Discovered Devices</h3>
        </div>

        <AnimatePresence mode="wait">
          {discoveredDevices.length === 0 ? (
            <motion.div 
              className="bg-white/10 backdrop-blur-lg rounded-2xl p-8 sm:p-12 text-center border border-white/20"
              initial={{ opacity: 0, scale: 0.9 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.9 }}
              transition={{ duration: 0.4 }}
            >
              <motion.div
                animate={isScanning ? { rotate: 360, scale: [1, 1.1, 1] } : {}}
                transition={isScanning ? { duration: 2, repeat: Infinity, ease: "linear" } : {}}
              >
                <Wifi className="mx-auto mb-4 text-blue-300" size={64} />
              </motion.div>
              <p className="text-slate-300 text-base sm:text-lg">
                {isScanning ? 'Scanning for devices...' : 'No devices found. Try scanning again.'}
              </p>
            </motion.div>
          ) : (
            <motion.div 
              className="space-y-4"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ duration: 0.4 }}
            >
              {discoveredDevices.map((device, index) => (
                <motion.div
                  key={device.id}
                  className="bg-gradient-to-r from-white/10 to-white/5 backdrop-blur-lg rounded-2xl p-4 sm:p-6 border border-white/20 hover:border-white/40 transition-all"
                  initial={{ opacity: 0, x: -20 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ delay: index * 0.1 }}
                  whileHover={{ scale: 1.02, y: -2 }}
                >
                  <div className="flex flex-col sm:flex-row items-center justify-between gap-4">
                    <div className="flex items-center space-x-4">
                      <motion.div
                        className="bg-gradient-to-r from-purple-400 to-pink-400 p-3 rounded-xl"
                        whileHover={{ rotate: [0, -5, 5, 0] }}
                        transition={{ duration: 0.5 }}
                      >
                        <Speaker className="text-white" size={24} />
                      </motion.div>
                      <div>
                        <h4 className="text-white font-bold text-base sm:text-lg">{device.name}</h4>
                        <p className="text-slate-300 font-mono text-xs sm:text-sm">{device.ip}:{device.port}</p>
                        <div className="flex items-center space-x-2 mt-1">
                          <div className="w-2 h-2 bg-emerald-400 rounded-full"></div>
                          <span className="text-emerald-400 text-xs font-medium">Quality: {device.quality}</span>
                        </div>
                      </div>
                    </div>
                    <motion.button
                      onClick={() => connectToDevice(device)}
                      disabled={state.connectionStatus === 'connecting'}
                      className={`px-4 sm:px-6 py-2 sm:py-3 rounded-xl font-semibold text-xs sm:text-base transition-all ${
                        state.connectionStatus === 'connecting'
                          ? 'bg-gray-400 cursor-not-allowed'
                          : 'bg-gradient-to-r from-emerald-500 to-cyan-500 hover:from-emerald-600 hover:to-cyan-600'
                      } text-white`}
                      whileHover={state.connectionStatus !== 'connecting' ? { scale: 1.05 } : {}}
                      whileTap={state.connectionStatus !== 'connecting' ? { scale: 0.95 } : {}}
                    >
                      {state.connectionStatus === 'connecting' ? 'Connecting...' : 'Connect'}
                    </motion.button>
                  </div>
                </motion.div>
              ))}
            </motion.div>
          )}
        </AnimatePresence>
      </motion.div>
    </motion.div>
  );
};

export default PlayTab;

