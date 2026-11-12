export type ServiceStatus = 'awaiting_setup' | 'awaiting_order' | 'linked' | 'review' | 'closed' | 'cancelled' | 'expired';
export interface ServiceItem { name: string; quantity: number; sumMinor: number | null }
export interface ServiceOrderView { status: 'open' | 'paid' | 'refund' | 'review'; billMinor: number | null; openedAt: string | null; closedAt: string | null; items: ServiceItem[]; comment?: string }
export interface ServiceCandidate { externalId: string; status: ServiceOrderView['status']; billMinor: number | null; openedAt: string | null }
export interface ServiceSessionView {
  id: string; venueId: string; guestId: string; tableLabel: string; status: ServiceStatus;
  createdAt: string; updatedAt: string; expiresAt: string; canCancel: boolean;
  order?: ServiceOrderView; staffUserId?: number; note?: string; candidates?: ServiceCandidate[];
}
export interface ServiceReadiness { venueId: string; ready: boolean; staffMapped: boolean; tableLabels: string[] }
export interface ServiceMapping {
  venueId: string; connectionId: string;
  tables: { label: string; posTableId: string }[];
  staff: { userId: number; posWaiterId: string }[];
}
