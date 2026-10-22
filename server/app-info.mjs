import fs from 'node:fs';
export const appInfo = Object.freeze({
  name: 'Trae Switch',
  version: JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version,
  repository: 'https://github.com/AI-Good-Tool/Trae-Api',
  author: 'https://github.com/vs2pk0',
  feedback: 'https://github.com/AI-Good-Tool/Trae-Api/issues',
  releases: 'https://github.com/AI-Good-Tool/Trae-Api/releases',
});
