// CI entry for the network layer: spins up the local relay, runs the Node-bot load test through the real session
// code (4 bots, one ~55 s race), and exits non-zero on divergence/errors. No browser needed.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const port = 8700 + Math.floor(Math.random() * 200);
const relay = spawn(process.execPath, [path.join(root, 'tools/relay.mjs'), String(port), '--latency=30', '--jitter=10'], { stdio: ['ignore', 'inherit', 'inherit'] });
await new Promise((r) => setTimeout(r, 800));
const test = spawn(process.execPath, [path.join(root, 'tools/loadtest.mjs'), 'relay', process.argv[2] || '4', process.argv[3] || '40', `ws://localhost:${port}`], { stdio: 'inherit' });
const codeExit = await new Promise((r) => test.on('exit', r));
relay.kill();
process.exit(codeExit ?? 1);
