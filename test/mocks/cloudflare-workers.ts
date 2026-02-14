/**
 * Minimal mock of the `cloudflare:workers` module so we can import WarmPool
 * without the real Workers runtime.
 */
export class DurableObject {
  protected ctx: any;
  protected env: any;

  constructor(ctx: any, env: any) {
    this.ctx = ctx;
    this.env = env;
  }
}
