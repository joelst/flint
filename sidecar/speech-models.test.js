import { describe, expect, it } from 'vitest';
import {
  getSpeechModelStrategy,
  getSpeechModelStrategyForVariants,
  SPEECH_SDK_VERSION,
} from './speech-models.js';
import { readFileSync } from 'node:fs';

describe('speech model strategy', () => {
  it('routes Whisper variants to URI inference', () => {
    expect(getSpeechModelStrategy('voice-model', 'whisper-tiny-generic-cpu:1')).toMatchObject({
      family: 'whisper',
      strategy: 'audioUri',
      supported: true,
    });
  });

  it('routes English, Spanish, and 3.5 Nemotron names to ItemQueue', () => {
    for (const alias of [
      'nemotron-speech-en-0.6b',
      'nemotron-speech-streaming-es-0.6b',
      'nemotron-3.5-asr-streaming-0.6b',
    ]) {
      expect(getSpeechModelStrategy(alias).strategy, alias).toBe('itemQueue');
    }
  });

  it('prefers the canonical variant family when the alias is opaque', () => {
    expect(getSpeechModelStrategy('local-voice', 'nemotron-3.5-asr-streaming-0.6b-generic-cpu:1')).toMatchObject({
      family: 'nemotron',
      strategy: 'itemQueue',
    });
  });

  it('prefers the canonical variant family when the alias names another family', () => {
    expect(getSpeechModelStrategy('parakeet-voice', 'whisper-tiny-generic-cpu:1')).toMatchObject({
      family: 'whisper',
      strategy: 'audioUri',
      supported: true,
    });
  });

  it('reports Parakeet as unsupported by the probed runtime', () => {
    expect(getSpeechModelStrategy('parakeet-tdt-0.6b-v2')).toEqual({
      family: 'parakeet',
      strategy: null,
      supported: false,
      reason: `Parakeet transcription is not supported by Foundry Local SDK ${SPEECH_SDK_VERSION}.`,
    });
  });

  it('resolves an opaque alias when every cached variant belongs to Parakeet', () => {
    expect(getSpeechModelStrategyForVariants('local-voice', [
      'parakeet-tdt-0.6b-v3-generic-cpu:1',
      'parakeet-tdt-0.6b-v3-cuda-gpu:1',
    ])).toMatchObject({
      family: 'parakeet',
      supported: false,
    });
  });

  it('prefers unanimous cached variants over a misleading alias', () => {
    expect(getSpeechModelStrategyForVariants('parakeet-voice', [
      'whisper-tiny-generic-cpu:1',
      'whisper-tiny-cuda-gpu:1',
    ])).toMatchObject({
      family: 'whisper',
      supported: true,
    });
  });

  it('defers opaque aliases with mixed or unknown cached variant families', () => {
    expect(getSpeechModelStrategyForVariants('local-voice', [
      'parakeet-tdt-0.6b-v3-generic-cpu:1',
      'whisper-tiny-generic-cpu:1',
    ]).family).toBe('unknown');
    expect(getSpeechModelStrategyForVariants('local-voice', [
      'parakeet-tdt-0.6b-v3-generic-cpu:1',
      'custom-asr-generic-cpu:1',
    ]).family).toBe('unknown');
  });

  it('defers mixed cached families even when the alias names Parakeet', () => {
    expect(getSpeechModelStrategyForVariants('parakeet-voice', [
      'parakeet-tdt-0.6b-v3-generic-cpu:1',
      'whisper-tiny-generic-cpu:1',
    ])).toMatchObject({
      family: 'unknown',
      supported: true,
    });
  });

  it('uses one URI attempt for a family not in the compatibility table', () => {
    expect(getSpeechModelStrategy('local-asr')).toMatchObject({
      family: 'unknown',
      strategy: 'audioUri',
      supported: true,
    });
  });

  it('requires the compatibility rules to track the installed Foundry SDK version', () => {
    const packageJson = JSON.parse(readFileSync('package.json', 'utf8'));
    expect(packageJson.dependencies['foundry-local-sdk']).toBe(SPEECH_SDK_VERSION);
  });
});
