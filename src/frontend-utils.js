(function () {
  'use strict';

  function simpleConfigToCron(config) {
    if (!config) return '* * * * *';
    switch (config.type) {
      case 'interval':
        return `*/${config.minutes ?? 5} * * * *`;
      case 'daily':
        return `${config.minute ?? 0} ${config.hour ?? 9} * * *`;
      case 'weekly':
        return `${config.minute ?? 0} ${config.hour ?? 9} * * ${config.day ?? 1}`;
      default:
        return '* * * * *';
    }
  }

  function createMicrotaskBatch(callback) {
    let pending = false;
    return () => {
      if (pending) return;
      pending = true;
      queueMicrotask(() => {
        pending = false;
        callback();
      });
    };
  }

  const utilities = { simpleConfigToCron, createMicrotaskBatch };
  if (typeof module !== 'undefined' && module.exports) module.exports = utilities;
  else window.frontendUtils = Object.freeze(utilities);
})();
