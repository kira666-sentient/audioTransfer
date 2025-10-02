import { useState } from 'react';
import { Radio, Play, HelpCircle, Waves } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { Toaster } from 'react-hot-toast';
import StreamTab from './components/StreamTab';
import PlayTab from './components/PlayTab';
import SupportTab from './components/SupportTab';
import { AudioProvider } from './context/AudioContext';

type TabType = 'stream' | 'play' | 'support';

function App() {
  const [activeTab, setActiveTab] = useState<TabType>('stream');

  const tabs = [
    { id: 'stream' as TabType, label: 'Stream', icon: Radio, gradient: 'from-emerald-400 to-cyan-400' },
    { id: 'play' as TabType, label: 'Play', icon: Play, gradient: 'from-violet-400 to-purple-400' },
    { id: 'support' as TabType, label: 'Support', icon: HelpCircle, gradient: 'from-amber-400 to-orange-400' },
  ];

  const renderTabContent = () => {
    switch (activeTab) {
      case 'stream':
        return <StreamTab />;
      case 'play':
        return <PlayTab />;
      case 'support':
        return <SupportTab />;
      default:
        return <StreamTab />;
    }
  };

  return (
    <AudioProvider>
      <div className="min-h-screen bg-gradient-to-br from-slate-900 via-purple-900 to-slate-900 relative overflow-x-hidden">
        <div className="container-custom py-6 relative">
          {/* Animated Background Elements */}
          <div className="absolute inset-0 overflow-hidden pointer-events-none">
            <motion.div
              className="absolute top-20 left-20 w-72 h-72 bg-gradient-to-r from-blue-400/20 to-purple-400/20 rounded-full blur-3xl"
            animate={{
              x: [0, 100, 0],
              y: [0, -50, 0],
              scale: [1, 1.2, 1],
            }}
            transition={{
              duration: 20,
              repeat: Infinity,
              ease: "easeInOut"
            }}
          />
          <motion.div
            className="absolute bottom-20 right-20 w-96 h-96 bg-gradient-to-r from-emerald-400/20 to-cyan-400/20 rounded-full blur-3xl"
            animate={{
              x: [0, -80, 0],
              y: [0, 60, 0],
              scale: [1.2, 1, 1.2],
            }}
            transition={{
              duration: 25,
              repeat: Infinity,
              ease: "easeInOut"
            }}
          />
        </div>

          <div className="relative z-10 min-h-screen w-full">
            <div className="flex flex-col items-center space-y-8">
          {/* Header with Animation */}
          <motion.header 
            className="w-full max-w-4xl text-center mb-8 sm:mb-12"
            initial={{ opacity: 0, y: -50 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.8, ease: "easeOut" }}
          >
            <motion.div
              className="flex flex-col sm:flex-row items-center justify-center mb-4 gap-2"
              whileHover={{ scale: 1.05 }}
              transition={{ type: "spring", stiffness: 300 }}
            >
              <motion.div
                className="bg-gradient-to-r from-blue-400 to-purple-400 p-3 rounded-2xl mr-0 sm:mr-4 mb-2 sm:mb-0"
                animate={{ rotate: [0, 5, -5, 0] }}
                transition={{ duration: 3, repeat: Infinity }}
              >
                <Waves className="text-white" size={32} />
              </motion.div>
              <h1 className="text-4xl sm:text-5xl md:text-6xl font-black bg-gradient-to-r from-white via-blue-100 to-purple-100 bg-clip-text text-transparent">
                Audio Transfer
              </h1>
            </motion.div>
            <motion.p 
              className="text-base sm:text-xl text-slate-300 font-medium"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ delay: 0.3, duration: 0.6 }}
            >
              Stream and play audio across your local network with{' '}
              <span className="bg-gradient-to-r from-emerald-400 to-cyan-400 bg-clip-text text-transparent font-bold">
                crystal clear quality
              </span>
            </motion.p>
          </motion.header>

          {/* Enhanced Tab Navigation */}
          <motion.div 
            className="w-full flex justify-center mb-8 sm:mb-12"
            initial={{ opacity: 0, y: 50 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.2, duration: 0.6 }}
          >
            <div className="w-full max-w-3xl bg-white/10 backdrop-blur-xl rounded-2xl p-2 border border-white/20 shadow-2xl">
              <div className="flex flex-wrap justify-center gap-2">
                {tabs.map((tab, index) => {
                  const IconComponent = tab.icon;
                  const isActive = activeTab === tab.id;
                  return (
                    <motion.button
                      key={tab.id}
                      onClick={() => setActiveTab(tab.id)}
                      className={`relative flex items-center space-x-3 px-6 sm:px-8 py-3 sm:py-4 rounded-xl font-semibold transition-all duration-300 overflow-hidden ${
                        isActive
                          ? 'text-white shadow-lg'
                          : 'text-slate-300 hover:text-white hover:bg-white/10'
                      }`}
                      whileHover={{ scale: 1.02 }}
                      whileTap={{ scale: 0.98 }}
                      initial={{ opacity: 0, x: -20 }}
                      animate={{ opacity: 1, x: 0 }}
                      transition={{ delay: index * 0.1 }}
                    >
                      {isActive && (
                        <motion.div
                          className={`absolute inset-0 bg-gradient-to-r ${tab.gradient} rounded-xl`}
                          layoutId="activeTab"
                          transition={{ type: "spring", stiffness: 300, damping: 30 }}
                        />
                      )}
                      <motion.div 
                        className="relative z-10 flex items-center space-x-3"
                        whileHover={{ scale: 1.05 }}
                      >
                        <IconComponent size={22} />
                        <span>{tab.label}</span>
                      </motion.div>
                    </motion.button>
                  );
                })}
              </div>
            </div>
          </motion.div>

          {/* Enhanced Tab Content */}
          <motion.div 
            className="w-full max-w-4xl mx-auto"
            initial={{ opacity: 0, y: 30 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.4, duration: 0.6 }}
          >
            <motion.div 
              className="bg-white/10 backdrop-blur-xl rounded-3xl p-4 sm:p-8 border border-white/20 shadow-2xl"
              whileHover={{ y: -2 }}
              transition={{ type: "spring", stiffness: 300 }}
            >
              <AnimatePresence mode="wait">
                <motion.div
                  key={activeTab}
                  initial={{ opacity: 0, x: 20 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: -20 }}
                  transition={{ duration: 0.3 }}
                >
                  {renderTabContent()}
                </motion.div>
              </AnimatePresence>
            </motion.div>
          </motion.div>
            </div>
          </div>
        </div>

        {/* Toaster for notifications */}
        <Toaster
          position="top-right"
          toastOptions={{
            style: {
              background: 'rgba(15, 23, 42, 0.9)',
              color: '#fff',
              border: '1px solid rgba(255, 255, 255, 0.2)',
              backdropFilter: 'blur(10px)',
            },
          }}
        />
      </div>
    </AudioProvider>
  );
}

export default App;