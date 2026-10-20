// A bind mount hides image-created /data children. Prepare only missing homes
// as the current user; never change existing ownership, modes or contents.
import { mkdirSync } from 'node:fs';
import { isAbsolute } from 'node:path';

export function prepareHomes(env = process.env) {
  for (const [name, fallback] of [['HOME', '/data/home'], ['DSH_HOME', '/data/dsh']]) {
    const path = env[name] ?? fallback;
    if (!isAbsolute(path)) throw new Error(`${name} must be an absolute directory path.`);
    try {
      mkdirSync(path, { recursive: true, mode: 0o700 });
    } catch {
      // No path/environment values or credentials in the error message.
      throw new Error(`Cannot prepare ${name}. Make its dedicated bind directory writable by the runtime user (default UID 1000); no ownership or permissions were changed.`);
    }
  }
}
