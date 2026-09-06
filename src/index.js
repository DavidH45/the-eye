'use strict';

// Runs both parts in one process. You can also run them separately:
//   npm run bot   (the tracker)
//   npm run web   (the dashboard)

require('./server');

try {
  require('./bot');
} catch (err) {
  console.error('[index] bot failed to start:', err.message);
  console.error('[index] the web dashboard is still running.');
}
