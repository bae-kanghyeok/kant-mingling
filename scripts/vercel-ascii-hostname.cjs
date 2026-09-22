// Vercel CLI 59.23.2 puts the OS hostname in an HTTP User-Agent header.
// Encode non-ASCII hostnames inside this Node process without changing the OS.
/* eslint-disable @typescript-eslint/no-require-imports -- Node --require preloads use CommonJS. */
const os = require("node:os");
const { syncBuiltinESMExports } = require("node:module");
const originalHostname = os.hostname;
os.hostname = () => encodeURIComponent(originalHostname());
syncBuiltinESMExports();
