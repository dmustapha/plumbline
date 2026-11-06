// File: apps/broker/src/killswitch.ts
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { TokenService } from './tokens.ts';

export class KillSwitch {
  #engaged: boolean;
  #reason = '';
  constructor(private readonly flagPath: string, private readonly tokens: TokenService) {
    this.#engaged = existsSync(flagPath);
    // AG4-BRK-8: a restart with the flag present must not re-validate tokens minted before the kill.
    if (this.#engaged) tokens.revokeAll();
  }

  engaged(): boolean {
    return this.#engaged;
  }

  view(): { engaged: boolean; reason: string } {
    return { engaged: this.#engaged, reason: this.#reason };
  }

  engage(reason: string): void {
    this.#engaged = true;
    this.#reason = reason;
    mkdirSync(dirname(this.flagPath), { recursive: true });
    writeFileSync(this.flagPath, `${new Date().toISOString()} ${reason}\n`);
    this.tokens.revokeAll();
  }

  clear(): void {
    this.#engaged = false;
    this.#reason = '';
    rmSync(this.flagPath, { force: true });
  }
}
