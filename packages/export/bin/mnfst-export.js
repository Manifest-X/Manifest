#!/usr/bin/env node
import { main } from '../manifest.export.mjs';

main().catch((err) => {
  console.error('mnfst-export:', err && err.stack ? err.stack : err);
  process.exit(1);
});
