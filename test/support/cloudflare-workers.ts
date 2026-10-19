// Node stand-in for the `cloudflare:workers` module, enough to construct MemoryVault in tests.
export class DurableObject<Env = unknown> {
  protected ctx: any;
  protected env: Env;
  constructor(ctx: any, env: Env) {
    this.ctx = ctx;
    this.env = env;
  }
}
