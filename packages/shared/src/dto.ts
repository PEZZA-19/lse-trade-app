/** Shapes returned by the API. Kept in one place so the web app and API agree. */
import type { JobStatus, QuoteStatus } from './schemas';
import type { LineKind } from './quote-calc';

export interface SiteDto {
  id: string;
  customerId: string;
  label: string | null;
  address: string;
  notes: string | null;
}

export interface CustomerDto {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  billingAddress: string | null;
  notes: string | null;
  markupBp: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface CustomerDetailDto extends CustomerDto {
  sites: SiteDto[];
  quotes: QuoteSummaryDto[];
  jobs: JobSummaryDto[];
}

export interface QuoteLineDto {
  id: string;
  position: number;
  kind: LineKind;
  description: string;
  qtyMilli: number;
  unitCostPence: number | null;
  markupBp: number | null;
  unitPricePence: number | null;
  optionLabel: string | null;
  taxRateBp: number;
  /** Computed by the server with the shared pricing rules. */
  unitSellPence: number;
  totalPence: number;
}

export interface QuoteRevisionDto {
  id: string;
  revision: number;
  revisionLetter: string;
  title: string;
  notes: string | null;
  validDays: number;
  sentAt: string | null;
  supersededAt: string | null;
  acceptedOptions: string[];
  lines: QuoteLineDto[];
  totals: { corePence: number; options: Record<string, number>; totalPence: number; costPence: number };
}

export interface QuoteSummaryDto {
  id: string;
  number: string;
  displayNumber: string;
  status: QuoteStatus;
  customerId: string;
  customerName: string;
  siteId: string | null;
  title: string;
  currentRevision: number;
  totalPence: number;
  convertedJobId: string | null;
  convertedJobNumber: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface QuoteDetailDto extends QuoteSummaryDto {
  site: SiteDto | null;
  revisions: Pick<QuoteRevisionDto, 'id' | 'revision' | 'revisionLetter' | 'sentAt' | 'supersededAt'>[];
  current: QuoteRevisionDto;
}

export interface JobSummaryDto {
  id: string;
  number: string;
  status: JobStatus;
  customerId: string;
  customerName: string;
  siteId: string | null;
  siteAddress: string | null;
  title: string;
  sourceQuoteId: string | null;
  sourceQuoteNumber: string | null;
  quotedTotalPence: number;
  createdAt: string;
  updatedAt: string;
}

export interface JobLineDto {
  id: string;
  position: number;
  kind: LineKind;
  description: string;
  qtyMilli: number;
  unitCostPence: number | null;
  unitSellPence: number;
  totalPence: number;
  source: 'quote' | 'manual';
}

export interface JobDetailDto extends JobSummaryDto {
  description: string | null;
  placeOfWork: 'sark' | 'guernsey' | 'other';
  site: SiteDto | null;
  sourceQuoteRevision: number | null;
  lines: JobLineDto[];
}

export interface ApiErrorBody {
  error: { code: string; message: string; details?: unknown };
}

export interface Page<T> {
  items: T[];
  total: number;
}
