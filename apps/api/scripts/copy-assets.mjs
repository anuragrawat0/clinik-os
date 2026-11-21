// tsc does not copy non-TypeScript assets. Copy them next to the compiled output.
import { cp } from 'node:fs/promises';
import { resolve } from 'node:path';

const assets = ['modules/identity/core/common-passwords.txt'];

for (const asset of assets) {
  await cp(resolve('src', asset), resolve('dist', asset));
}
