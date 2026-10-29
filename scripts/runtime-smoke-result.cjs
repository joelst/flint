'use strict';

function isRuntimeSmokeSuccessful(result) {
  const output = `${result.stdout || ''}\n${result.stderr || ''}`;
  return result.status === 0 && output.includes('[flint] runtime smoke: ready');
}

module.exports = { isRuntimeSmokeSuccessful };
