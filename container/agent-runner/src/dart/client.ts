import type {
  DartClientOptions,
  JsonObject,
  ListFilingsInput,
} from './types.js';

export class DartApiError extends Error {
  constructor(
    public readonly status: string,
    public readonly apiMessage: string,
  ) {
    super(`OpenDART ${status}: ${apiMessage}`);
  }
}

export class OpenDartClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: DartClientOptions) {
    if (!options.apiKey) throw new Error('DART_API_KEY is required');
    this.baseUrl = options.baseUrl ?? 'https://opendart.fss.or.kr/api';
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async requestJson(
    endpoint: string,
    params: Record<string, string | number | undefined>,
  ): Promise<JsonObject> {
    const url = new URL(`${this.baseUrl}/${endpoint}`);
    url.searchParams.set('crtfc_key', this.options.apiKey);
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== '') {
        url.searchParams.set(key, String(value));
      }
    }
    const response = await this.fetchImpl(url);
    if (!response.ok) throw new Error(`HTTP ${response.status} for ${endpoint}`);
    const data = (await response.json()) as JsonObject;
    const status = typeof data.status === 'string' ? data.status : undefined;
    if (status && status !== '000') {
      throw new DartApiError(status, String(data.message ?? 'OpenDART error'));
    }
    return data;
  }

  listFilings(input: ListFilingsInput): Promise<JsonObject> {
    return this.requestJson('list.json', {
      corp_code: input.corpCode,
      bgn_de: input.bgnDe,
      end_de: input.endDe,
      last_reprt_at: input.lastReprtAt,
      pblntf_ty: input.pblntfTy,
      pblntf_detail_ty: input.pblntfDetailTy,
      corp_cls: input.corpCls,
      sort: input.sort,
      sort_mth: input.sortMth,
      page_no: input.pageNo,
      page_count: input.pageCount,
    });
  }

  companyInfo(corpCode: string): Promise<JsonObject> {
    return this.requestJson('company.json', { corp_code: corpCode });
  }

  singleFinancialStatement(
    corpCode: string,
    bsnsYear: string,
    reprtCode: string,
  ): Promise<JsonObject> {
    return this.requestJson('fnlttSinglAcntAll.json', {
      corp_code: corpCode,
      bsns_year: bsnsYear,
      reprt_code: reprtCode,
    });
  }
}
