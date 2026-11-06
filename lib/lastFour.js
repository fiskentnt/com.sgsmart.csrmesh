'use strict';

// An id in the log as its last four characters, "…61e2": enough to tell
// nodes apart within one log, too little to name a peripheral or a home.
// A value of four characters or fewer is shown as it is.
function lastFour(value) {
  const text = String(value === undefined || value === null ? '' : value);
  return text.length > 4 ? `…${text.slice(-4)}` : text;
}

module.exports = { lastFour };
