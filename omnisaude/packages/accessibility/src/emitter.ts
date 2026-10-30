/** Emissor de eventos tipado, sem dependências (roda no navegador e no Node). */
export class TypedEmitter<Events extends Record<string, unknown>> {
  private readonly listeners = new Map<keyof Events, Set<(payload: never) => void>>();

  on<K extends keyof Events>(event: K, listener: (payload: Events[K]) => void): () => void {
    let set = this.listeners.get(event);
    if (!set) this.listeners.set(event, (set = new Set()));
    set.add(listener as (payload: never) => void);
    return () => set!.delete(listener as (payload: never) => void);
  }

  protected emit<K extends keyof Events>(event: K, payload: Events[K]): void {
    for (const l of this.listeners.get(event) ?? []) (l as (p: Events[K]) => void)(payload);
  }

  removeAllListeners(): void {
    this.listeners.clear();
  }
}
