#!/usr/bin/env node
import { main } from '../manifest.publish.mjs';

main().catch((err) => {
  console.error('mnfst-publish:', err && err.message ? err.message : err);
  process.exit(1);
});
