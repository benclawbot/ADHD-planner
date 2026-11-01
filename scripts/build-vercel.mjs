import { cp, copyFile, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'dist');

await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
await cp(path.join(root, 'src'), path.join(output, 'src'), { recursive: true });
await copyFile(path.join(output, 'src', 'index.html'), path.join(output, 'index.html'));

console.log('Tempo Planner static build ready.');
