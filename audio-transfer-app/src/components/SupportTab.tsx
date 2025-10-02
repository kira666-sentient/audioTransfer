import { HelpCircle, Smartphone, Monitor, Wifi, Volume2, Settings, ExternalLink } from 'lucide-react';

const SupportTab = () => {
  const faqs = [
    {
      question: "How do I start streaming audio?",
      answer: "Go to the Stream tab, select your audio source (microphone, system audio, or file), choose quality settings, and click 'Start Streaming'. Your device will act as a server that others can connect to."
    },
    {
      question: "How do I connect to another device's stream?",
      answer: "In the Play tab, click 'Scan for Devices' to automatically discover nearby streams, or manually enter the IP address of the streaming device. Click 'Connect' to start listening."
    },
    {
      question: "What audio sources can I stream?",
      answer: "You can stream from your microphone, system audio (what's playing on your computer), or audio files. System audio capture may require additional permissions."
    },
    {
      question: "Why can't I find other devices?",
      answer: "Make sure all devices are connected to the same Wi-Fi network. Check that firewalls aren't blocking the connection. The streaming device must have started streaming first."
    },
    {
      question: "What do the quality settings mean?",
      answer: "Higher quality settings provide better audio but use more bandwidth. Choose based on your network speed: Low (64kbps) for slow networks, Ultra (320kbps) for best quality."
    },
    {
      question: "Can I use this over the internet?",
      answer: "Currently, this app only works on local networks (same Wi-Fi). Internet streaming will be added in future updates."
    }
  ];

  const troubleshooting = [
    {
      issue: "Audio not working",
      solutions: [
        "Check microphone/audio permissions in browser",
        "Ensure audio source is not muted",
        "Try refreshing the page",
        "Check system volume levels"
      ]
    },
    {
      issue: "Connection problems",
      solutions: [
        "Verify both devices are on same network",
        "Check firewall settings",
        "Try manual IP connection",
        "Restart the streaming device"
      ]
    },
    {
      issue: "Poor audio quality",
      solutions: [
        "Reduce quality settings for slower networks",
        "Move closer to Wi-Fi router",
        "Close other bandwidth-heavy applications",
        "Check for network interference"
      ]
    }
  ];

  const systemRequirements = {
    web: {
      title: "Web Browser",
      requirements: [
        "Chrome 66+ or Firefox 60+",
        "Microphone/audio permissions",
        "Local network connection",
        "Minimum 1 Mbps bandwidth"
      ]
    },
    mobile: {
      title: "Mobile (Coming Soon)",
      requirements: [
        "Android 7.0+ or iOS 12+",
        "Wi-Fi connection",
        "Microphone permissions",
        "Background audio support"
      ]
    },
    desktop: {
      title: "Desktop App (Coming Soon)",
      requirements: [
        "Windows 10+, macOS 10.14+, or Linux",
        "Audio drivers installed",
        "Network access permissions",
        "50MB free space"
      ]
    }
  };

  return (
      <div className="space-y-6 w-full max-w-3xl mx-auto px-4">
      <div className="text-center">
        <h2 className="text-2xl font-bold text-white mb-2">Support & Help</h2>
        <p className="text-blue-100">Everything you need to know about Audio Transfer</p>
      </div>

      {/* Quick Start Guide */}
      <div className="bg-white/20 rounded-xl p-6">
        <h3 className="text-white font-semibold text-lg mb-4 flex items-center">
          <HelpCircle className="mr-2" size={20} />
          Quick Start Guide
        </h3>
        <div className="grid md:grid-cols-2 gap-6">
          <div>
            <h4 className="text-white font-medium mb-3 flex items-center">
              <Monitor className="mr-2" size={16} />
              To Stream Audio:
            </h4>
            <ol className="text-blue-100 space-y-2 text-sm">
              <li>1. Go to the Stream tab</li>
              <li>2. Select your audio source</li>
              <li>3. Choose quality settings</li>
              <li>4. Click "Start Streaming"</li>
              <li>5. Share your IP address with others</li>
            </ol>
          </div>
          <div>
            <h4 className="text-white font-medium mb-3 flex items-center">
              <Volume2 className="mr-2" size={16} />
              To Listen:
            </h4>
            <ol className="text-blue-100 space-y-2 text-sm">
              <li>1. Go to the Play tab</li>
              <li>2. Scan for devices or enter IP manually</li>
              <li>3. Click "Connect" on desired stream</li>
              <li>4. Adjust volume and enjoy!</li>
            </ol>
          </div>
        </div>
      </div>

      {/* System Requirements */}
      <div className="bg-white/20 rounded-xl p-6">
        <h3 className="text-white font-semibold text-lg mb-4 flex items-center">
          <Settings className="mr-2" size={20} />
          System Requirements
        </h3>
        <div className="grid md:grid-cols-3 gap-4">
          {Object.entries(systemRequirements).map(([key, platform]) => {
            const icons = {
              web: Monitor,
              mobile: Smartphone,
              desktop: Monitor
            };
            const IconComponent = icons[key as keyof typeof icons];
            
            return (
              <div key={key} className="bg-white/10 rounded-lg p-4">
                <h4 className="text-white font-medium mb-3 flex items-center">
                  <IconComponent className="mr-2" size={16} />
                  {platform.title}
                </h4>
                <ul className="text-blue-100 text-sm space-y-1">
                  {platform.requirements.map((req, index) => (
                    <li key={index}>• {req}</li>
                  ))}
                </ul>
              </div>
            );
          })}
        </div>
      </div>

      {/* FAQ Section */}
      <div className="bg-white/20 rounded-xl p-6">
        <h3 className="text-white font-semibold text-lg mb-4">Frequently Asked Questions</h3>
        <div className="space-y-4">
          {faqs.map((faq, index) => (
            <details key={index} className="bg-white/10 rounded-lg">
              <summary className="p-4 cursor-pointer text-white font-medium hover:bg-white/20 transition-colors">
                {faq.question}
              </summary>
              <div className="p-4 pt-0 text-blue-100 text-sm">
                {faq.answer}
              </div>
            </details>
          ))}
        </div>
      </div>

      {/* Troubleshooting */}
      <div className="bg-white/20 rounded-xl p-6">
        <h3 className="text-white font-semibold text-lg mb-4">Troubleshooting</h3>
        <div className="space-y-4">
          {troubleshooting.map((item, index) => (
            <div key={index} className="bg-white/10 rounded-lg p-4">
              <h4 className="text-white font-medium mb-2">{item.issue}</h4>
              <ul className="text-blue-100 text-sm space-y-1">
                {item.solutions.map((solution, sIndex) => (
                  <li key={sIndex}>• {solution}</li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </div>

      {/* Network Requirements */}
      <div className="bg-white/20 rounded-xl p-6">
        <h3 className="text-white font-semibold text-lg mb-4 flex items-center">
          <Wifi className="mr-2" size={20} />
          Network Requirements
        </h3>
        <div className="grid md:grid-cols-2 gap-6">
          <div>
            <h4 className="text-white font-medium mb-2">Minimum Bandwidth</h4>
            <ul className="text-blue-100 text-sm space-y-1">
              <li>• Low Quality: 64 kbps</li>
              <li>• Medium Quality: 128 kbps</li>
              <li>• High Quality: 256 kbps</li>
              <li>• Ultra Quality: 320 kbps</li>
            </ul>
          </div>
          <div>
            <h4 className="text-white font-medium mb-2">Network Setup</h4>
            <ul className="text-blue-100 text-sm space-y-1">
              <li>• All devices on same Wi-Fi network</li>
              <li>• Router with multicast support</li>
              <li>• No firewall blocking ports 3000-3010</li>
              <li>• Stable internet connection</li>
            </ul>
          </div>
        </div>
      </div>

      {/* Contact & Links */}
      <div className="bg-white/20 rounded-xl p-6">
        <h3 className="text-white font-semibold text-lg mb-4">Need More Help?</h3>
        <div className="space-y-3">
          <p className="text-blue-100 text-sm">
            Can't find what you're looking for? We're here to help!
          </p>
          <div className="flex flex-wrap gap-4">
            <a
              href="#"
              className="inline-flex items-center space-x-2 text-blue-300 hover:text-white transition-colors"
            >
              <ExternalLink size={16} />
              <span>Documentation</span>
            </a>
            <a
              href="#"
              className="inline-flex items-center space-x-2 text-blue-300 hover:text-white transition-colors"
            >
              <ExternalLink size={16} />
              <span>GitHub Repository</span>
            </a>
            <a
              href="#"
              className="inline-flex items-center space-x-2 text-blue-300 hover:text-white transition-colors"
            >
              <ExternalLink size={16} />
              <span>Report Issues</span>
            </a>
          </div>
        </div>
      </div>

      {/* Version Info */}
      <div className="text-center text-blue-200 text-sm">
        <p>Audio Transfer v1.0.0</p>
        <p>Built with React, WebRTC, and ❤️</p>
      </div>
    </div>
  );
};

export default SupportTab;

