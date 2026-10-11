import { cpSync, mkdirSync } from 'node:fs';
mkdirSync('assets', { recursive: true });
cpSync('../src/template.html', 'assets/template.html');
