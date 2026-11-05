#!/usr/bin/env node
const argv = process.argv.slice(2);

const run = argv[0] === 'journeys'
    ? import('../browser.mjs').then(m => m.cli(argv.slice(1)))
    : import('../manifest.test.mjs').then(m => m.main(argv));

run.then((exitCode) => {
    process.exit(exitCode || 0);
}).catch((err) => {
    console.error('mnfst-test:', err.message || err);
    process.exit(2);
});
