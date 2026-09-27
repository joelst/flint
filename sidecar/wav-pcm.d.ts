export interface WavHeader {
  view: DataView;
  formatCode: number;
  numChannels: number;
  sampleRate: number;
  bitsPerSample: number;
  bytesPerSample: number;
  frameSize: number;
  frameCount: number;
  dataOffset: number;
  dataLength: number;
  isFloat: boolean;
  isInt: boolean;
}

export function parseWavHeader(input: ArrayBuffer | Uint8Array): WavHeader;
export function extractNemotronPcm(input: ArrayBuffer | Uint8Array): Uint8Array;
