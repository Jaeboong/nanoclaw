export type JsonObject = Record<string, unknown>;

export interface DartClientOptions {
  apiKey: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

export interface ListFilingsInput {
  corpCode?: string;
  bgnDe?: string;
  endDe?: string;
  lastReprtAt?: 'Y' | 'N';
  pblntfTy?: string;
  pblntfDetailTy?: string;
  corpCls?: string;
  sort?: 'date' | 'crp' | 'rpt';
  sortMth?: 'asc' | 'desc';
  pageNo?: number;
  pageCount?: number;
}
