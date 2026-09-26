'use strict';

const CANONICAL_UPDATER_ENDPOINT = 'https://github.com/joelst/flint/releases/latest/download/latest.json';
const RELEASE_CHANNELS = ['stable', 'evaluation'];

function normalizeVersion(version) {
  if (!version) return version;
  const partial = String(version).match(/^(\d+\.\d+)(-[a-zA-Z0-9.-]+)?$/);
  return partial ? `${partial[1]}.0${partial[2] || ''}` : version;
}

function isNumericIdentifier(value) {
  return /^(0|[1-9]\d*)$/.test(value);
}

function isIdentifier(value) {
  return /^[0-9A-Za-z-]+$/.test(value) &&
    !(value.length > 1 && value.startsWith('0') && /^\d+$/.test(value));
}

function parseSemver(value) {
  const text = String(value);
  const plus = text.indexOf('+');
  if (plus !== -1) return null;

  const hyphen = text.indexOf('-');
  const core = hyphen === -1 ? text : text.slice(0, hyphen);
  const prereleaseText = hyphen === -1 ? '' : text.slice(hyphen + 1);
  const coreParts = core.split('.');
  if (coreParts.length !== 3 || !coreParts.every(isNumericIdentifier)) return null;

  const prerelease = prereleaseText ? prereleaseText.split('.') : [];
  if (hyphen !== -1 && (!prerelease.length || prerelease.some((part) => !isIdentifier(part)))) {
    return null;
  }
  return { prerelease };
}

function isStrictSemver(value) {
  return parseSemver(value) !== null;
}

function isCanonicalUpdaterEndpoint(endpoint) {
  try {
    return new URL(endpoint).href === CANONICAL_UPDATER_ENDPOINT;
  } catch {
    return false;
  }
}

function validateReleaseInputs(version, channel) {
  if (!version || !isStrictSemver(version) || !RELEASE_CHANNELS.includes(channel)) {
    return 'invalid version or release channel';
  }
  if (channel === 'stable' && parseSemver(version).prerelease.length > 0) {
    return `${version} is a prerelease but the release channel is stable`;
  }
  return null;
}

module.exports = {
  CANONICAL_UPDATER_ENDPOINT,
  isCanonicalUpdaterEndpoint,
  isStrictSemver,
  normalizeVersion,
  parseSemver,
  validateReleaseInputs,
};
