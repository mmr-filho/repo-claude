/** Tipos mínimos do pacote "shapefile" (mbostock, BSD-3-Clause), que não publica declarações. */
declare module 'shapefile' {
  export interface Fonte {
    read(): Promise<{ done: boolean; value: unknown }>;
    cancel(): Promise<void>;
  }
  export function open(shp: ArrayBuffer | Uint8Array | string, dbf?: ArrayBuffer | Uint8Array | string, options?: { encoding?: string }): Promise<Fonte>;
}
