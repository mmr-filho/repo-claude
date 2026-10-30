export interface StockLocation {
  id: string;
  name: string;
  kind: 'ALMOXARIFADO_CENTRAL' | 'FARMACIA_CENTRAL' | 'FARMACIA_SETORIAL' | 'POSTO_ENFERMAGEM';
  unitId: string;
  unit: { id: string; name: string; type: string };
}

export interface StockItem {
  locationId: string;
  locationName: string;
  productId: string;
  productCode: string;
  product: string;
  unit: string;
  controlledList: string | null;
  highAlert: boolean;
  lotId: string;
  lot: string;
  expiry: string;
  quantity: number;
  alert: 'VENCIDO' | 'VENCE_EM_BREVE' | null;
}

export interface StockResponse {
  items: StockItem[];
  alerts: { expired: number; expiringSoon: number; windowDays: number };
}

export interface Product {
  id: string;
  code: string;
  description: string;
  activeIngredient: string | null;
  unit: string;
  gtin: string | null;
  catmat: string | null;
  controlledList: string | null;
  highAlert: boolean;
  antimicrobialRestricted: boolean;
}

export const LOCATION_KIND_LABELS: Record<StockLocation['kind'], string> = {
  ALMOXARIFADO_CENTRAL: 'Almoxarifado central',
  FARMACIA_CENTRAL: 'Farmácia central',
  FARMACIA_SETORIAL: 'Farmácia setorial',
  POSTO_ENFERMAGEM: 'Posto de enfermagem',
};
