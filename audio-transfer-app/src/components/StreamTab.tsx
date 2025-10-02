import { useState, useEffect } from 'react';
import { Mic, Monitor, FileAudio, Users, Settings, Play, Square, Zap, Signal } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import toast from 'react-hot-toast';
import { useAudio } from '../context/AudioContext';

const StreamTab = () => {
  const { state, dispatch, mediaStreamRef } = useAudio();
  const [localIP, setLocalIP] = useState<string>('');
  const [serverPort] = useState(3001);

  useEffect(() => {
    // Get local IP for display
    const getLocalIP = async () => {
      try {
        // This is a simple way to get local IP - in production you'd want a more robust method
        const response = await fetch('https://api.ipify.org?format=json');
        await response.json(); // We fetch but don't use the external IP
        // For local network, we'll show the internal IP
        setLocalIP('192.168.1.100'); // Placeholder - in real app, detect actual local IP
      } catch (error) {
        setLocalIP('localhost');
      }
    };
    getLocalIP();
  }, []);

  const qualitySettings = {
    low: { bitrate: 64, sampleRate: 22050, label: 'Low (64kbps)' },
    medium: { bitrate: 128, sampleRate: 44100, label: 'Medium (128kbps)' },
    high: { bitrate: 256, sampleRate: 44100, label: 'High (256kbps)' },
    ultra: { bitrate: 320, sampleRate: 48000, label: 'Ultra (320kbps)' },
  };

  const audioSources = [
    { value: 'microphone', label: 'Microphone', icon: Mic, description: 'Stream from microphone input', gradient: 'from-emerald-500 to-teal-500' },
    { value: 'system', label: 'System Audio', icon: Monitor, description: 'Stream computer audio', gradient: 'from-blue-500 to-indigo-500' },
    { value: 'file', label: 'Audio File', icon: FileAudio, description: 'Stream from audio file', gradient: 'from-purple-500 to-pink-500' },
  ];

  const startStreaming = async () => {
    const loadingToast = toast.loading('Starting stream...', {
      icon: '🎵',
    });

    try {
      let stream: MediaStream;
      
      if (state.audioSource === 'microphone') {
        stream = await navigator.mediaDevices.getUserMedia({ 
          audio: {
            sampleRate: qualitySettings[state.audioQuality].sampleRate,
            channelCount: 2,
            echoCancellation: true,
            noiseSuppression: true,
          } 
        });
      } else if (state.audioSource === 'system') {
        // @ts-ignore - getDisplayMedia for system audio capture
        stream = await navigator.mediaDevices.getDisplayMedia({ 
          audio: true,
          video: false 
        });
      } else {
        // File streaming would be implemented separately
        throw new Error('File streaming not implemented yet');
      }

      mediaStreamRef.current = stream;
      dispatch({ type: 'START_STREAMING' });
      dispatch({ type: 'SET_CONNECTION_STATUS', payload: 'connected' });
      
      toast.dismiss(loadingToast);
      toast.success('Stream started successfully!', {
        icon: '🎶',
        duration: 3000,
      });
      
      console.log('Started streaming with quality:', state.audioQuality);
      
    } catch (error) {
      console.error('Error starting stream:', error);
      toast.dismiss(loadingToast);
      toast.error('Failed to start stream. Please check permissions.', {
        icon: '❌',
        duration: 4000,
      });
    }
  };

  const stopStreaming = () => {
    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach(track => track.stop());
      mediaStreamRef.current = null;
    }
    dispatch({ type: 'STOP_STREAMING' });
    dispatch({ type: 'SET_CONNECTION_STATUS', payload: 'disconnected' });
    
    toast.success('Stream stopped', {
      icon: '⏹️',
      duration: 2000,
    });
  };

  return (
  <div className="space-y-8 w-full max-w-2xl mx-auto px-2 sm:px-6 md:px-8">
      {/* Header */}
      <motion.div 
        className="text-center"
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.6 }}
      >
        <motion.h2 
          className="text-3xl font-bold bg-gradient-to-r from-white to-gray-200 bg-clip-text text-transparent mb-3"
          whileHover={{ scale: 1.02 }}
        >
          🎵 Stream Audio
        </motion.h2>
        <p className="text-slate-300 text-lg">Start a server to share your audio with crystal clear quality</p>
      </motion.div>

      {/* Server Info Card */}
      <motion.div 
        className="bg-gradient-to-r from-blue-500/20 to-purple-500/20 backdrop-blur-xl rounded-2xl p-6 border border-white/20"
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ delay: 0.1, duration: 0.5 }}
        whileHover={{ scale: 1.02, y: -2 }}
      >
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center space-x-3">
            <motion.div
              className="bg-gradient-to-r from-emerald-400 to-cyan-400 p-2 rounded-xl"
              animate={{ rotate: [0, 5, -5, 0] }}
              transition={{ duration: 4, repeat: Infinity }}
            >
              <Signal className="text-white" size={24} />
            </motion.div>
            <div>
              <h3 className="text-white font-semibold text-lg">Server Address</h3>
              <p className="text-slate-300 text-sm">Your streaming endpoint</p>
            </div>
          </div>
          <motion.div
            className={`px-3 py-1 rounded-full text-xs font-medium ${
              state.connectionStatus === 'connected' 
                ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-400/30' 
                : 'bg-slate-500/20 text-slate-400 border border-slate-400/30'
            }`}
            animate={{ scale: state.connectionStatus === 'connected' ? [1, 1.05, 1] : 1 }}
            transition={{ duration: 2, repeat: state.connectionStatus === 'connected' ? Infinity : 0 }}
          >
            {state.connectionStatus === 'connected' ? '🟢 LIVE' : '⚪ OFFLINE'}
          </motion.div>
        </div>
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-slate-300">Local IP:</span>
            <motion.span 
              className="font-mono text-white bg-white/10 px-3 py-1 rounded-lg"
              whileHover={{ scale: 1.05 }}
            >
              {localIP}:{serverPort}
            </motion.span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-slate-300">Device:</span>
            <span className="text-white font-medium">{state.deviceName}</span>
          </div>
        </div>
      </motion.div>

      {/* Audio Source Selection */}
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.2, duration: 0.5 }}
      >
        <div className="flex items-center space-x-2 mb-6">
          <motion.div
            animate={{ rotate: 360 }}
            transition={{ duration: 8, repeat: Infinity, ease: "linear" }}
          >
            <Settings className="text-white" size={20} />
          </motion.div>
          <h3 className="text-white font-semibold text-xl">Audio Source</h3>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {audioSources.map((source, index) => {
            const IconComponent = source.icon;
            const isSelected = state.audioSource === source.value;
            return (
              <motion.button
                key={source.value}
                onClick={() => dispatch({ type: 'SET_AUDIO_SOURCE', payload: source.value as any })}
                className={`relative p-6 rounded-2xl border-2 transition-all duration-300 overflow-hidden ${
                  isSelected
                    ? 'border-white text-white shadow-2xl'
                    : 'border-white/20 text-slate-300 hover:border-white/40 hover:text-white'
                }`}
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.3 + index * 0.1 }}
                whileHover={{ scale: 1.05, y: -5 }}
                whileTap={{ scale: 0.95 }}
              >
                {isSelected && (
                  <motion.div
                    className={`absolute inset-0 bg-gradient-to-br ${source.gradient} opacity-20`}
                    layoutId="selectedSource"
                    transition={{ type: "spring", stiffness: 300, damping: 30 }}
                  />
                )}
                <div className="relative z-10">
                  <motion.div
                    className={`mx-auto mb-4 p-3 rounded-2xl w-fit ${
                      isSelected 
                        ? `bg-gradient-to-br ${source.gradient}` 
                        : 'bg-white/10'
                    }`}
                    whileHover={{ rotate: [0, -5, 5, 0] }}
                    transition={{ duration: 0.5 }}
                  >
                    <IconComponent size={28} />
                  </motion.div>
                  <div className="font-semibold text-lg mb-2">{source.label}</div>
                  <div className="text-sm opacity-80">{source.description}</div>
                </div>
              </motion.button>
            );
          })}
        </div>
      </motion.div>

      {/* Quality Settings */}
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.4, duration: 0.5 }}
      >
        <div className="flex items-center space-x-2 mb-6">
          <motion.div
            animate={{ scale: [1, 1.2, 1] }}
            transition={{ duration: 2, repeat: Infinity }}
          >
            <Zap className="text-yellow-400" size={20} />
          </motion.div>
          <h3 className="text-white font-semibold text-xl">Audio Quality</h3>
        </div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {Object.entries(qualitySettings).map(([quality, settings], index) => (
            <motion.button
              key={quality}
              onClick={() => dispatch({ type: 'SET_AUDIO_QUALITY', payload: quality as any })}
              className={`p-4 rounded-xl border-2 transition-all duration-300 ${
                state.audioQuality === quality
                  ? 'border-emerald-400 bg-emerald-500/20 text-white shadow-lg'
                  : 'border-white/20 text-slate-300 hover:border-white/40 hover:bg-white/10'
              }`}
              initial={{ opacity: 0, scale: 0.8 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ delay: 0.5 + index * 0.05 }}
              whileHover={{ scale: 1.05 }}
              whileTap={{ scale: 0.95 }}
            >
              <div className="font-semibold">{settings.label}</div>
              <div className="text-xs mt-1 opacity-70">{settings.sampleRate / 1000}kHz</div>
            </motion.button>
          ))}
        </div>
      </motion.div>

      {/* Streaming Controls */}
      <motion.div 
        className="flex flex-col items-center space-y-6"
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.6, duration: 0.5 }}
      >
        <AnimatePresence mode="wait">
          {!state.isStreaming ? (
            <motion.button
              key="start"
              onClick={startStreaming}
              className="bg-gradient-to-r from-emerald-500 to-cyan-500 hover:from-emerald-600 hover:to-cyan-600 text-white px-12 py-5 rounded-2xl font-semibold text-lg flex items-center space-x-3 shadow-2xl"
              initial={{ opacity: 0, scale: 0.8 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.8 }}
              whileHover={{ scale: 1.05, y: -2 }}
              whileTap={{ scale: 0.95 }}
            >
              <motion.div
                animate={{ rotate: 360 }}
                transition={{ duration: 4, repeat: Infinity, ease: "linear" }}
              >
                <Play size={24} />
              </motion.div>
              <span>Start Streaming</span>
            </motion.button>
          ) : (
            <motion.div
              key="streaming"
              className="space-y-6 w-full max-w-md"
              initial={{ opacity: 0, scale: 0.8 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.8 }}
            >
              <motion.button
                onClick={stopStreaming}
                className="w-full bg-gradient-to-r from-red-500 to-pink-500 hover:from-red-600 hover:to-pink-600 text-white px-8 py-4 rounded-2xl font-semibold text-lg flex items-center justify-center space-x-3 shadow-2xl"
                whileHover={{ scale: 1.02 }}
                whileTap={{ scale: 0.98 }}
              >
                <Square size={24} />
                <span>Stop Streaming</span>
              </motion.button>
              
              {/* Live Streaming Indicator */}
              <motion.div 
                className="bg-gradient-to-r from-emerald-500/20 to-cyan-500/20 backdrop-blur-xl rounded-2xl p-6 border border-emerald-400/30"
                animate={{ scale: [1, 1.02, 1] }}
                transition={{ duration: 2, repeat: Infinity }}
              >
                <div className="flex items-center justify-center space-x-3 mb-4">
                  <motion.div
                    className="w-3 h-3 bg-emerald-400 rounded-full"
                    animate={{ scale: [1, 1.5, 1], opacity: [1, 0.5, 1] }}
                    transition={{ duration: 1.5, repeat: Infinity }}
                  />
                  <span className="text-emerald-400 font-semibold text-lg">🔴 LIVE STREAMING</span>
                </div>
                <div className="flex items-center justify-center space-x-2 text-slate-300">
                  <Users size={20} />
                  <span>
                    {state.connectedDevices.length === 0 
                      ? 'Waiting for connections...' 
                      : `${state.connectedDevices.length} device(s) connected`
                    }
                  </span>
                </div>
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Audio Visualizer Mock */}
        {state.isStreaming && (
          <motion.div 
            className="flex items-end justify-center space-x-1 h-16"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 0.5 }}
          >
            {[...Array(12)].map((_, i) => (
              <motion.div
                key={i}
                className="bg-gradient-to-t from-emerald-500 to-cyan-400 w-2 rounded-full"
                animate={{
                  height: [8, Math.random() * 40 + 20, 8],
                }}
                transition={{
                  duration: 0.5 + Math.random() * 0.5,
                  repeat: Infinity,
                  ease: "easeInOut",
                  delay: i * 0.1,
                }}
              />
            ))}
          </motion.div>
        )}
      </motion.div>
    </div>
  );
};

export default StreamTab;

