#!/usr/bin/env node
import { main } from '../manifest.render.mjs';

main().catch((err) => {
  console.error('prerender:', err);
  process.exit(1);
});
