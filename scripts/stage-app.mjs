import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
export function stageApp(root, manifest) {
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'trae-switch-package-'));
  for (const name of ['server', 'ui', 'desktop.cjs', 'preload.cjs'])
    fs.cpSync(path.join(root, name), path.join(staging, name), { recursive: true });
  fs.writeFileSync(
    path.join(staging, 'package.json'),
    JSON.stringify({
      name: manifest.name,
      productName: manifest.productName,
      version: manifest.version,
      type: 'module',
      main: 'desktop.cjs',
      private: true,
    }),
  );
  return staging;
}
