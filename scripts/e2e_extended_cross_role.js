// Reuse the ten-tab fixtures in a separate lane to keep full-suite chunk durations bounded.
process.env.E2E_RECORD_FILTER = 'tab-state-preserve-10-tabs';
process.env.E2E_CROSS_ROLE_ROUNDS = '1';
require('./e2e_chunk3');
