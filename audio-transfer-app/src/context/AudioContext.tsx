import React, { createContext, useContext, useReducer, useRef } from 'react';

export type AudioQuality = 'low' | 'medium' | 'high' | 'ultra';
export type AudioSource = 'microphone' | 'system' | 'file';
export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected';

interface AudioState {
  isStreaming: boolean;
  isPlaying: boolean;
  connectionStatus: ConnectionStatus;
  audioQuality: AudioQuality;
  audioSource: AudioSource;
  connectedDevices: string[];
  serverUrl: string;
  volume: number;
  deviceName: string;
}

type AudioAction =
  | { type: 'START_STREAMING' }
  | { type: 'STOP_STREAMING' }
  | { type: 'START_PLAYING' }
  | { type: 'STOP_PLAYING' }
  | { type: 'SET_CONNECTION_STATUS'; payload: ConnectionStatus }
  | { type: 'SET_AUDIO_QUALITY'; payload: AudioQuality }
  | { type: 'SET_AUDIO_SOURCE'; payload: AudioSource }
  | { type: 'SET_CONNECTED_DEVICES'; payload: string[] }
  | { type: 'SET_SERVER_URL'; payload: string }
  | { type: 'SET_VOLUME'; payload: number }
  | { type: 'SET_DEVICE_NAME'; payload: string };

const initialState: AudioState = {
  isStreaming: false,
  isPlaying: false,
  connectionStatus: 'disconnected',
  audioQuality: 'medium',
  audioSource: 'microphone',
  connectedDevices: [],
  serverUrl: '',
  volume: 50,
  deviceName: 'My Device',
};

const audioReducer = (state: AudioState, action: AudioAction): AudioState => {
  switch (action.type) {
    case 'START_STREAMING':
      return { ...state, isStreaming: true };
    case 'STOP_STREAMING':
      return { ...state, isStreaming: false };
    case 'START_PLAYING':
      return { ...state, isPlaying: true };
    case 'STOP_PLAYING':
      return { ...state, isPlaying: false };
    case 'SET_CONNECTION_STATUS':
      return { ...state, connectionStatus: action.payload };
    case 'SET_AUDIO_QUALITY':
      return { ...state, audioQuality: action.payload };
    case 'SET_AUDIO_SOURCE':
      return { ...state, audioSource: action.payload };
    case 'SET_CONNECTED_DEVICES':
      return { ...state, connectedDevices: action.payload };
    case 'SET_SERVER_URL':
      return { ...state, serverUrl: action.payload };
    case 'SET_VOLUME':
      return { ...state, volume: action.payload };
    case 'SET_DEVICE_NAME':
      return { ...state, deviceName: action.payload };
    default:
      return state;
  }
};

interface AudioContextType {
  state: AudioState;
  dispatch: React.Dispatch<AudioAction>;
  mediaStreamRef: React.MutableRefObject<MediaStream | null>;
  audioContextRef: React.MutableRefObject<AudioContext | null>;
}

const AudioContext = createContext<AudioContextType | undefined>(undefined);

export const AudioProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [state, dispatch] = useReducer(audioReducer, initialState);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);

  const value = {
    state,
    dispatch,
    mediaStreamRef,
    audioContextRef,
  };

  return <AudioContext.Provider value={value}>{children}</AudioContext.Provider>;
};

export const useAudio = () => {
  const context = useContext(AudioContext);
  if (context === undefined) {
    throw new Error('useAudio must be used within an AudioProvider');
  }
  return context;
};

