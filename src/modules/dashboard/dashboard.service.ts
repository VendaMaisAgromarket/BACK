import { PrismaClient } from "@prisma/client";
import { calculatePipelineStage, PIPELINE_STAGES } from "../../lib/pipelineStage";

interface MonthBucket {
  key: string; // "2026-07"
  label: string; // "jul/2026"
  start: Date;
  end: Date; // exclusivo
}

interface MonthlyValue {
  month: string;
  label: string;
  previsto: number;
  realizado: number;
}

interface MoneySeries {
  monthly: MonthlyValue[];
  accumulated: { previsto: number; realizado: number };
}

interface CountSeries {
  monthly: MonthlyValue[];
}

/** Filtros de produto/comprador/vendedor/tipoOperacao — compartilhados entre executive-overview e pipeline. */
export interface SaleFilters {
  produtoId?: string;
  compradorId?: string;
  vendedorId?: string;
  /**
   * Aceito por paridade com os demais dropdowns do front, mas hoje sem efeito: não existe no schema
   * um campo que represente "tipo de operação" (o mais próximo, TransportTypes, é sobre transporte,
   * não sobre a natureza do negócio). Fica em standby até o cliente definir a fonte desse dado.
   */
  tipoOperacao?: string;
}

export interface FilterOption {
  id: string;
  name: string;
}

export interface ExecutiveFilterOptions {
  produtos: FilterOption[];
  compradores: FilterOption[];
  vendedores: FilterOption[];
  /** Sempre [] por enquanto — ver SaleFilters.tipoOperacao. */
  tiposOperacao: FilterOption[];
}

export interface ExecutiveCounters {
  operacoesAtivas: number;
  operacoesConcluidas: number;
  operacoesBloqueadas: number;
  valorRetido: number;
}

export interface ProductRevenue {
  produto: string;
  valor: number;
  percentual: number;
}

export interface RouteAggregate {
  origem: string;
  destino: string;
  quantidade: number;
  valor: number;
}

export interface PartyRanking {
  nome: string;
  faturamento: number;
  percentualParticipacao: number;
}

export interface ExecutiveOverview {
  period: { from: string; to: string };
  faturamento: MoneySeries;
  receita: MoneySeries;
  operacoes: CountSeries;
  counters: ExecutiveCounters;
  filterOptions: ExecutiveFilterOptions;
  faturamentoPorProduto: ProductRevenue[];
  origemDestino: RouteAggregate[];
  principaisCompradores: PartyRanking[];
  principaisVendedores: PartyRanking[];
  pipeline: PipelineSummary;
}

function buildLastMonths(now: Date, count: number): MonthBucket[] {
  const buckets: MonthBucket[] = [];
  for (let i = count - 1; i >= 0; i--) {
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    const end = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1));
    const key = `${start.getUTCFullYear()}-${String(start.getUTCMonth() + 1).padStart(2, "0")}`;
    const label = start.toLocaleDateString("pt-BR", { month: "short", year: "numeric", timeZone: "UTC" });
    buckets.push({ key, label, start, end });
  }
  return buckets;
}

function buildLast12Months(now: Date): MonthBucket[] {
  return buildLastMonths(now, 12);
}

function monthKey(date: Date): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

function round2(value: number): number {
  return parseFloat(value.toFixed(2));
}

function round1(value: number): number {
  return parseFloat(value.toFixed(1));
}

function diffInDays(from: Date, to: Date): number {
  return (to.getTime() - from.getTime()) / 86_400_000;
}

function daysBetween(from: Date, to: Date): number {
  return Math.max(0, Math.floor(diffInDays(from, to)));
}

function average(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

function contractTotalOf(sale: {
  transportValue: number;
  adjustedContractTotal: number | null;
  boughtProducts: { value: number }[];
}): number {
  return sale.adjustedContractTotal ?? sale.boughtProducts.reduce((sum, bp) => sum + bp.value, 0) + sale.transportValue;
}

const UNKNOWN_UF = "N/D";
const TOP_RANKING_SIZE = 5;

/**
 * produto/vendedor precisam bater na MESMA linha de boughtProducts (o produto X vendido pelo vendedor Y),
 * por isso viram um único `some` combinado — dois `some` separados poderiam casar itens diferentes da venda.
 */
function buildSaleFilterWhere(filters: SaleFilters): Record<string, unknown> {
  const where: Record<string, unknown> = {};
  if (filters.compradorId) where.buyerId = filters.compradorId;
  if (filters.produtoId || filters.vendedorId) {
    where.boughtProducts = {
      some: {
        ...(filters.produtoId && { productId: filters.produtoId }),
        ...(filters.vendedorId && { product: { sellerId: filters.vendedorId } }),
      },
    };
  }
  return where;
}

/**
 * buildSaleFilterWhere só garante que a VENDA tenha ao menos uma linha batendo com produto/vendedor —
 * uma venda com múltiplos vendedores/produtos continua trazendo TODAS as linhas de boughtProducts.
 * Os agregados por linha (faturamento por produto, origem x destino, principais vendedores) precisam
 * reaplicar o mesmo filtro aqui, por item, senão vazam produtos/vendedores fora do filtro selecionado.
 */
function boughtProductMatchesFilters(
  bp: { productId: string; product: { sellerId: string } },
  filters: SaleFilters
): boolean {
  if (filters.produtoId && bp.productId !== filters.produtoId) return false;
  if (filters.vendedorId && bp.product.sellerId !== filters.vendedorId) return false;
  return true;
}

/**
 * 8 baldes cumulativos (stage >= minStage) alinhados 1:1 com o "Funil de Operações" do mockup.
 * "Liberado para Embarque" consolida as etapas internas 3-5 (liberação p/ colheita, colheita/embarque,
 * pesagem+docs) num único marco visível ao cliente — o balde cumulativo já inclui as 3 automaticamente.
 */
const FUNNEL_BUCKETS = [
  { key: "contrato_criado", label: "Contrato Criado", minStage: 1 },
  { key: "pagamento_validado", label: "Pagamento Validado", minStage: 2 },
  { key: "liberado_embarque", label: "Liberado para Embarque", minStage: 3 },
  { key: "em_transporte", label: "Em Transporte", minStage: 6 },
  { key: "entregue", label: "Entregue", minStage: 7 },
  { key: "aceite", label: "Aceite", minStage: 8 },
  { key: "pagamento_liberado", label: "Pagamento Liberado", minStage: 9 },
  { key: "finalizada", label: "Finalizada", minStage: 10 },
] as const;

/**
 * Mesma consolidação do funil aplicada ao status individual de cada operação (lista/tabela) — as
 * etapas internas 3-5 mostram todas como "Liberado para Embarque". stage 1 é renomeado para
 * "Aguardando Pagamento" (mais descritivo pra quem está olhando uma operação parada nessa etapa).
 */
const CONSOLIDATED_STAGE_LABELS: Record<number, string> = {
  1: "Aguardando Pagamento",
  2: "Pagamento Validado",
  3: "Liberado para Embarque",
  4: "Liberado para Embarque",
  5: "Liberado para Embarque",
  6: "Em Transporte",
  7: "Entregue",
  8: "Aceite",
  9: "Pagamento Liberado",
  10: "Finalizada",
};

/**
 * "Bloqueada" é um selo visual sobre o status real (não uma etapa nova): a operação continua na sua
 * etapa de fato, mas exibe "Bloqueada" quando tem pagamento pending vencido há mais de
 * PENDING_PAYMENT_OVERDUE_DAYS dias (mesma regra de getOperationalAlerts.pagamentoVencido) — reaproveitada
 * aqui em vez de inventar uma nova régua de "operação bloqueada".
 */
function displayStatusLabel(stageResult: ReturnType<typeof calculatePipelineStage>, isBlocked: boolean): string {
  if (stageResult.stage === 0) return stageResult.label;
  if (isBlocked) return "Bloqueada";
  return CONSOLIDATED_STAGE_LABELS[stageResult.stage] ?? stageResult.label;
}

export interface StatusFilterOption {
  value: string;
  label: string;
  /** Etapas internas (calculatePipelineStage) que esse status engloba — usar em ?stage=. */
  stages?: number[];
  /** Quando true, usar ?blocked=true em vez de stage (ver displayStatusLabel). */
  blocked?: true;
}

/** Opções prontas pro dropdown "Status" do Pipeline — front monta ?stage=/?blocked= a partir daqui, sem hardcodar números de etapa. */
export const PIPELINE_STATUS_FILTER_OPTIONS: StatusFilterOption[] = [
  { value: "aguardando_pagamento", label: "Aguardando Pagamento", stages: [1] },
  { value: "pagamento_validado", label: "Pagamento Validado", stages: [2] },
  { value: "liberado_embarque", label: "Liberado para Embarque", stages: [3, 4, 5] },
  { value: "em_transporte", label: "Em Transporte", stages: [6] },
  { value: "entregue", label: "Entregue", stages: [7] },
  { value: "aceite", label: "Aceite", stages: [8] },
  { value: "pagamento_liberado", label: "Pagamento Liberado", stages: [9] },
  { value: "finalizada", label: "Finalizada", stages: [10] },
  { value: "bloqueada", label: "Bloqueada", blocked: true },
];

export interface PipelineStatusCount {
  stage: number;
  key: string;
  label: string;
  count: number;
}

export interface PipelineFunnelBucket {
  key: string;
  label: string;
  count: number;
}

export interface PipelineListItem {
  id: string;
  orderNumber: number;
  produto: string;
  comprador: string;
  vendedor: string;
  valor: number;
  status: string;
  diasEtapa: number;
}

export interface PipelineSummary {
  statusCounts: PipelineStatusCount[];
  terminal: PipelineStatusCount[];
  funnel: PipelineFunnelBucket[];
}

export interface PipelineCounters {
  operacoesAtivas: number;
  finalizadas: number;
  /** Etapa 1 (contrato criado, entrada ainda não confirmada) — mesma etapa exibida como "Aguardando Pagamento". */
  aguardandoPagamento: number;
  /** Ver displayStatusLabel — pagamento pending vencido há mais de PENDING_PAYMENT_OVERDUE_DAYS dias. */
  bloqueadas: number;
  taxaConversaoPercent: number;
  /** ativas + finalizadas (denominador da taxa de conversão) — exclui Cancelado/Recusado. */
  totalContratos: number;
}

export interface PipelineGargalos {
  aguardandoPagamento: number;
  bloqueadas: number;
  semDocumentos: number;
  entregaAtrasada: number;
}

export interface PipelineOverviewSummary extends PipelineSummary {
  counters: PipelineCounters;
  gargalos: PipelineGargalos;
}

export interface PipelineFilterOptions extends ExecutiveFilterOptions {
  status: StatusFilterOption[];
}

export interface PipelineListPage {
  items: PipelineListItem[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export interface PipelineDateFilter {
  startDate?: Date;
  endDate?: Date;
}

function buildCreatedAtWhere(filter: PipelineDateFilter): Record<string, unknown> {
  if (!filter.startDate && !filter.endDate) return {};
  return {
    createdAt: {
      ...(filter.startDate && { gte: filter.startDate }),
      ...(filter.endDate && { lte: filter.endDate }),
    },
  };
}

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

/**
 * Quando o filtro `stage` é usado sem startDate, o scan leve precisa de uma janela máxima —
 * senão pode virar um scan do dataset inteiro (etapa é campo derivado, não dá pra filtrar/paginar
 * só no banco). 180 dias cobre o uso prático (ver "quem está em tal etapa" recentemente).
 */
const MAX_STAGE_FILTER_WINDOW_DAYS = 180;

/** Prazo padrão (dias) considerado para um pagamento pendente "vencer" — mesmo default usado ao gerar boleto (expirationDays). */
const PENDING_PAYMENT_OVERDUE_DAYS = 3;
const DEFAULT_ALERT_LIST_LIMIT = 50;
const MAX_ALERT_LIST_LIMIT = 200;
const ACTIVE_SALE_STATUS_FILTER = { notIn: ["Cancelado", "Recusado pelo vendedor"] };

/**
 * Predicados das regras de alerta, extraídos pra serem reaproveitados pelo Pipeline (gargalos/contadores)
 * e pelos Alertas Operacionais, com os mesmos filtros de período/produto/comprador/vendedor/parceiro da
 * página — em vez de duplicar a lógica de negócio com um where escrito à mão em cada lugar.
 * Todas retornam `{ AND: [baseDaRegra, extra] }` em vez de espalhar `...extra` no mesmo objeto: um
 * spread direto sobrescreve silenciosamente qualquer chave que a regra e o `extra` tenham em comum —
 * já aconteceu de verdade com `OR` (documentosPendentesWhere define o seu, buildParceiroWhere também,
 * e o spread fazia o filtro de parceiro apagar a condição de documentos pendentes). Envolver os dois
 * objetos em `AND` evita essa classe inteira de bug, não só o caso do `OR`.
 */
function semPagamentoAntesColheitaWhere(now: Date, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { AND: [{ plannedHarvestDate: { lte: now }, downPaymentCompleted: false, status: ACTIVE_SALE_STATUS_FILTER }, extra] };
}
/**
 * "Documentos pendentes": nota fiscal não enviada após embarque OU comprovante de pesagem
 * (weightDocumentId) ainda não registrado após embarque — cobre "NF, ticket de pesagem ou outros
 * documentos" do mockup usando só campos que já existem, sem precisar de schema novo. Antes só
 * checava nota fiscal (nome anterior: semUploadDocumentosWhere).
 */
function documentosPendentesWhere(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    AND: [
      {
        shippedAt: { not: null },
        status: ACTIVE_SALE_STATUS_FILTER,
        OR: [{ operationDocuments: { none: { docType: "nota_fiscal" } } }, { weightDocumentId: null }],
      },
      extra,
    ],
  };
}
function entregaAtrasadaWhere(now: Date, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { AND: [{ plannedDeliveryDate: { lt: now }, actualDeliveryDate: null, status: ACTIVE_SALE_STATUS_FILTER }, extra] };
}
/**
 * paymentCompleted: false exclui vendas já totalmente pagas (etapa 9/10): o fluxo de criação de
 * pagamento permite mais de uma tentativa, então uma venda paga pode ainda ter um Payment 'pending'
 * mais antigo/alternativo — sem esse filtro, ela seria contada como vencida/bloqueada indevidamente.
 * Esta é a MESMA regra usada como "Bloqueada" no Pipeline (ver displayStatusLabel) e como "Bloqueadas
 * por regras" nos Alertas Operacionais — um único predicado, dois rótulos de exibição por página.
 */
function pagamentoVencidoWhere(overdueCutoff: Date, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    AND: [
      { status: ACTIVE_SALE_STATUS_FILTER, paymentCompleted: false, Payment: { some: { status: "pending", createdAt: { lt: overdueCutoff } } } },
      extra,
    ],
  };
}

/** Filtra por comprador OU vendedor da venda — usado pelo filtro "Parceiro" dos Alertas Operacionais. */
function buildParceiroWhere(parceiroId?: string): Record<string, unknown> {
  if (!parceiroId) return {};
  return { OR: [{ buyerId: parceiroId }, { boughtProducts: { some: { product: { sellerId: parceiroId } } } }] };
}

export const ALERT_CATEGORIAS = ["Financeiro", "Documentação", "Logística", "Contratual", "Outros"] as const;
export type AlertCategoria = (typeof ALERT_CATEGORIAS)[number];

export const ALERT_CRITICIDADES = ["Crítico", "Médio", "Baixo"] as const;
export type AlertCriticidade = (typeof ALERT_CRITICIDADES)[number];

type AlertRuleKey = "semPagamentoAntesColheita" | "documentosPendentes" | "entregaAtrasada" | "pagamentoVencido";

/**
 * Shape normalizado de fetchAlertTriggerRows — Payment só é buscado de verdade pra pagamentoVencido
 * (única regra que precisa dele); as outras 3 recebem `Payment: []` sem consultar o banco pra relação.
 */
interface AlertTriggerRow {
  id: string;
  plannedHarvestDate: Date | null;
  shippedAt: Date | null;
  plannedDeliveryDate: Date | null;
  Payment: { createdAt: Date }[];
}

/**
 * Categoria/criticidade/responsável/ação são fixos por TIPO de regra (não variam por venda) — mapeamento
 * direto do mockup (Financeiro=Crítico, Documentação/Logística=Médio). "Baixo" existe no tipo mas
 * nenhuma das 4 regras reais o produz hoje — reservado pra quando "sem termo aditivo" for modelado
 * (ver resumo de pendência entregue à parte). "Contratual"/"Outros" idem: categorias do mockup sem
 * regra real ainda, sempre 0 em porCategoria.
 */
const ALERT_RULE_META: Record<
  AlertRuleKey,
  { categoria: AlertCategoria; criticidade: AlertCriticidade; responsavel: "Comprador" | "Vendedor"; acao: string }
> = {
  semPagamentoAntesColheita: {
    categoria: "Financeiro",
    criticidade: "Crítico",
    responsavel: "Comprador",
    acao: "Cobrar pagamento da entrada",
  },
  documentosPendentes: {
    categoria: "Documentação",
    criticidade: "Médio",
    responsavel: "Vendedor",
    acao: "Cobrar envio dos documentos pendentes",
  },
  entregaAtrasada: {
    categoria: "Logística",
    criticidade: "Médio",
    responsavel: "Vendedor",
    acao: "Verificar status da entrega",
  },
  pagamentoVencido: {
    categoria: "Financeiro",
    criticidade: "Crítico",
    responsavel: "Comprador",
    acao: "Cobrar pagamento pendente",
  },
};

const ALERT_RULE_KEYS: AlertRuleKey[] = ["semPagamentoAntesColheita", "documentosPendentes", "entregaAtrasada", "pagamentoVencido"];

/** Meses sem dado histórico anterior à existência dessas regras no sistema não têm como ser recuperados — ver resumo de pendência. */
const EVOLUTION_MONTHS = 6;
/** Janela padrão de "resolvidos" quando a página não informa período — resolvidos sem limite de tempo não tem leitura útil. */
const DEFAULT_RESOLVED_WINDOW_DAYS = 30;

export interface OperationalAlertCounts {
  semPagamentoAntesColheita: number;
  documentosPendentes: number;
  entregaAtrasada: number;
  /** Mesma regra/definição de "Bloqueada" do Pipeline — ver ALERT_RULE_META/pagamentoVencidoWhere. */
  bloqueadas: number;
  /** Sempre 0 — não há campo no schema pra "termo aditivo". Ver resumo de pendência entregue ao time. */
  semTermoAditivo: number;
}

export interface AlertCategoryBreakdown {
  categoria: AlertCategoria;
  count: number;
  percentual: number;
}

export interface AlertMonthlyPoint {
  month: string;
  label: string;
  criticos: number;
  medios: number;
  resolvidos: number;
}

export interface OperationalAlertsCounters {
  criticos: number;
  medios: number;
  /** Aproximação sem histórico — ver comentário de countResolvedInPeriod e resumo de pendência. */
  resolvidos: number;
  bloqueadas: number;
  /** Ver computeSaudeOperacionalPercent — null quando não há operação ativa no escopo filtrado. */
  saudeOperacionalPercent: number | null;
}

export interface OperationalAlertItem {
  id: string;
  orderNumber: number;
  categoria: AlertCategoria;
  criticidade: AlertCriticidade;
  parceiro: string;
  descricao: string;
  dataHora: string;
  diasEmAberto: number;
  acao: string;
  status: "Aberto";
}

export interface OperationalAlertsFilterOptions {
  categorias: AlertCategoria[];
  criticidades: AlertCriticidade[];
  parceiros: FilterOption[];
}

export interface AlertFilters {
  categoria?: AlertCategoria;
  criticidade?: AlertCriticidade;
  parceiroId?: string;
}

export interface OperationalAlertsOverview {
  counters: OperationalAlertsCounters;
  counts: OperationalAlertCounts;
  porCategoria: AlertCategoryBreakdown[];
  evolucaoMensal: AlertMonthlyPoint[];
  filterOptions: OperationalAlertsFilterOptions;
  list: { items: OperationalAlertItem[]; total: number; limit: number };
}

/** Abaixo desse percentual de entregas no prazo, comprador/vendedor entra com alerta:true. */
const ON_TIME_ALERT_THRESHOLD_PERCENT = 80;

export interface LogisticsPartyPerformance {
  id: string;
  name: string;
  delivered: number;
  onTimePercent: number;
  alerta: boolean;
}

export interface LogisticsOverview {
  deliveredCount: number;
  averageDeliveryDays: number | null;
  onTimePercent: number | null;
  averageDelayDays: number | null;
  byBuyer: LogisticsPartyPerformance[];
  bySeller: LogisticsPartyPerformance[];
}

export class DashboardService {
  private readonly prisma: PrismaClient;

  constructor(prisma?: PrismaClient) {
    this.prisma = prisma || new PrismaClient();
  }

  /**
   * Visão Executiva: Faturamento (valor contratado) e Receita (valor efetivamente recebido)
   * Previsto x Realizado por mês, últimos 12 meses, + Operações (contagem) Previsto x Realizado.
   * Previsto agrupa pela data planejada de entrega (plannedDeliveryDate); Realizado agrupa pela
   * data efetiva (actualDeliveryDate para faturamento/operações, Payment.updatedAt para receita).
   */
  async getExecutiveOverview(filters: SaleFilters = {}, now: Date = new Date()): Promise<ExecutiveOverview> {
    const months = buildLast12Months(now);
    const windowStart = months[0].start;
    const windowEnd = months[months.length - 1].end;
    const saleFilterWhere = buildSaleFilterWhere(filters);

    const [previstoSales, realizadoSales, completedPayments, periodSales, filterCatalog] = await Promise.all([
      this.prisma.saleData.findMany({
        where: { plannedDeliveryDate: { gte: windowStart, lt: windowEnd }, ...saleFilterWhere },
        select: {
          plannedDeliveryDate: true,
          transportValue: true,
          adjustedContractTotal: true,
          boughtProducts: { select: { value: true } },
        },
      }),
      this.prisma.saleData.findMany({
        where: { actualDeliveryDate: { gte: windowStart, lt: windowEnd }, ...saleFilterWhere },
        select: {
          actualDeliveryDate: true,
          transportValue: true,
          adjustedContractTotal: true,
          boughtProducts: { select: { value: true } },
        },
      }),
      this.prisma.payment.findMany({
        where: { status: "completed", updatedAt: { gte: windowStart, lt: windowEnd }, sale: saleFilterWhere },
        select: { amount: true, updatedAt: true },
      }),
      this.getExecutivePeriodSales(windowStart, windowEnd, saleFilterWhere),
      this.getFilterCatalog({ createdAt: { gte: windowStart, lt: windowEnd } }),
    ]);

    const previstoPorMes = new Map<string, number>();
    const previstoOperacoesPorMes = new Map<string, number>();
    for (const sale of previstoSales) {
      const key = monthKey(sale.plannedDeliveryDate as Date);
      previstoPorMes.set(key, (previstoPorMes.get(key) ?? 0) + contractTotalOf(sale));
      previstoOperacoesPorMes.set(key, (previstoOperacoesPorMes.get(key) ?? 0) + 1);
    }

    const realizadoFaturamentoPorMes = new Map<string, number>();
    const realizadoOperacoesPorMes = new Map<string, number>();
    for (const sale of realizadoSales) {
      const key = monthKey(sale.actualDeliveryDate as Date);
      realizadoFaturamentoPorMes.set(key, (realizadoFaturamentoPorMes.get(key) ?? 0) + contractTotalOf(sale));
      realizadoOperacoesPorMes.set(key, (realizadoOperacoesPorMes.get(key) ?? 0) + 1);
    }

    const realizadoReceitaPorMes = new Map<string, number>();
    for (const payment of completedPayments) {
      const key = monthKey(payment.updatedAt);
      realizadoReceitaPorMes.set(key, (realizadoReceitaPorMes.get(key) ?? 0) + payment.amount);
    }

    const faturamentoMonthly: MonthlyValue[] = [];
    const receitaMonthly: MonthlyValue[] = [];
    const operacoesMonthly: MonthlyValue[] = [];

    for (const { key, label } of months) {
      const previsto = round2(previstoPorMes.get(key) ?? 0);
      faturamentoMonthly.push({ month: key, label, previsto, realizado: round2(realizadoFaturamentoPorMes.get(key) ?? 0) });
      receitaMonthly.push({ month: key, label, previsto, realizado: round2(realizadoReceitaPorMes.get(key) ?? 0) });
      operacoesMonthly.push({
        month: key,
        label,
        previsto: previstoOperacoesPorMes.get(key) ?? 0,
        realizado: realizadoOperacoesPorMes.get(key) ?? 0,
      });
    }

    const sumField = (arr: MonthlyValue[], field: "previsto" | "realizado") =>
      round2(arr.reduce((sum, m) => sum + m[field], 0));

    // periodSales considera createdAt (data do pedido) nos últimos 12 meses — mesmo critério de
    // "período" já usado em GET /dashboard/pipeline — diferente de previsto/realizado acima, que
    // olham plannedDeliveryDate/actualDeliveryDate. Um único scan alimenta pipeline/contadores/rankings.
    const stageResults = periodSales.map((sale) => calculatePipelineStage(sale, now));

    return {
      period: { from: months[0].key, to: months[months.length - 1].key },
      faturamento: {
        monthly: faturamentoMonthly,
        accumulated: { previsto: sumField(faturamentoMonthly, "previsto"), realizado: sumField(faturamentoMonthly, "realizado") },
      },
      receita: {
        monthly: receitaMonthly,
        accumulated: { previsto: sumField(receitaMonthly, "previsto"), realizado: sumField(receitaMonthly, "realizado") },
      },
      operacoes: { monthly: operacoesMonthly },
      counters: this.buildExecutiveCounters(periodSales, stageResults),
      filterOptions: { ...filterCatalog, tiposOperacao: [] },
      faturamentoPorProduto: this.buildFaturamentoPorProduto(periodSales, filters),
      origemDestino: this.buildOrigemDestino(periodSales, filters),
      principaisCompradores: this.buildPrincipaisCompradores(periodSales),
      principaisVendedores: this.buildPrincipaisVendedores(periodSales, filters),
      pipeline: this.tallyStageResults(stageResults),
    };
  }

  /**
   * Dataset único (1 venda = 1 linha) usado por counters/rankings/agregações do executive-overview.
   * Traz os mesmos campos "leves" de calculatePipelineStage + o necessário para valor/produto/comprador/
   * vendedor/UF, evitando um scan por bloco do dashboard.
   */
  private async getExecutivePeriodSales(windowStart: Date, windowEnd: Date, saleFilterWhere: Record<string, unknown>) {
    return this.prisma.saleData.findMany({
      where: { createdAt: { gte: windowStart, lt: windowEnd }, ...saleFilterWhere },
      select: {
        status: true,
        createdAt: true,
        statusChangedAt: true,
        downPaymentCompleted: true,
        paymentCompleted: true,
        shippedAt: true,
        arrivedAt: true,
        actualDeliveryDate: true,
        weightDocumentId: true,
        transportValue: true,
        adjustedContractTotal: true,
        buyerId: true,
        buyer: { select: { name: true } },
        shippingAddress: { select: { uf: true } },
        boughtProducts: {
          select: {
            productId: true,
            value: true,
            product: {
              select: {
                name: true,
                sellerId: true,
                seller: { select: { name: true, addresses: { where: { default: true }, take: 1, select: { uf: true } } } },
              },
            },
          },
        },
        Payment: { where: { status: "completed" }, select: { phase: true, status: true, updatedAt: true, amount: true } },
      },
    });
  }

  /**
   * Catálogo de opções pros dropdowns produto/comprador/vendedor — 3 consultas direcionadas (uma por
   * entidade, via filtro de relação) em vez de carregar toda venda + boughtProducts + produto + vendedor
   * do período só pra desduplicar em memória. Sem isso, num período sem filtro de data (ex.: pipeline sem
   * startDate) o custo crescia com o histórico inteiro de vendas — e rodava de novo a cada página pedida,
   * já que o controller chama isso em paralelo com list a cada request.
   * `saleWhere` é o mesmo filtro (createdAt, produto/comprador/vendedor) aplicado nas 3, só que reescrito
   * como filtro de relação (`some: saleWhere`) partindo de User/Product em vez de partir de SaleData.
   */
  private async getFilterCatalog(
    saleWhere: Record<string, unknown>
  ): Promise<Pick<ExecutiveFilterOptions, "produtos" | "compradores" | "vendedores">> {
    const [compradores, produtos, vendedores] = await Promise.all([
      this.prisma.user.findMany({
        where: { salesBuyer: { some: saleWhere } },
        select: { id: true, name: true },
      }),
      this.prisma.product.findMany({
        where: { boughtProducts: { some: { saleData: saleWhere } } },
        select: { id: true, name: true },
      }),
      this.prisma.user.findMany({
        where: { products: { some: { boughtProducts: { some: { saleData: saleWhere } } } } },
        select: { id: true, name: true },
      }),
    ]);

    const toSortedOptions = (rows: FilterOption[]): FilterOption[] =>
      [...rows].sort((a, b) => a.name.localeCompare(b.name, "pt-BR"));

    return {
      produtos: toSortedOptions(produtos),
      compradores: toSortedOptions(compradores),
      vendedores: toSortedOptions(vendedores),
    };
  }

  /**
   * Ativa/Concluída/Bloqueada reaproveitam a MESMA régua de etapa do pipeline (calculatePipelineStage),
   * em vez de uma segunda definição de status: stage 10 = concluída, stage 0 (Cancelado/Recusado) = bloqueada
   * (estado terminal que exige atenção), 1-9 = ativa.
   * valorRetido: soma dos pagamentos já confirmados (completed) das vendas cuja etapa está entre
   * "Pagamento em escrow" (2) e "Aceite" (8) — pago pelo comprador, mas ainda não liberado ao vendedor.
   */
  private buildExecutiveCounters(
    sales: Awaited<ReturnType<DashboardService["getExecutivePeriodSales"]>>,
    stageResults: ReturnType<typeof calculatePipelineStage>[]
  ): ExecutiveCounters {
    let operacoesAtivas = 0;
    let operacoesConcluidas = 0;
    let operacoesBloqueadas = 0;
    let valorRetido = 0;

    sales.forEach((sale, index) => {
      const stage = stageResults[index].stage;
      if (stage === 0) operacoesBloqueadas += 1;
      else if (stage === 10) operacoesConcluidas += 1;
      else operacoesAtivas += 1;

      if (stage >= 2 && stage <= 8) {
        valorRetido += sale.Payment.reduce((sum, p) => sum + p.amount, 0);
      }
    });

    return { operacoesAtivas, operacoesConcluidas, operacoesBloqueadas, valorRetido: round2(valorRetido) };
  }

  /** Agrupa por productId (Product.name não é @unique — nomes iguais em produtos diferentes não podem ser somados juntos). */
  private buildFaturamentoPorProduto(
    sales: Awaited<ReturnType<DashboardService["getExecutivePeriodSales"]>>,
    filters: SaleFilters
  ): ProductRevenue[] {
    const totals = new Map<string, { nome: string; valor: number }>();
    for (const sale of sales) {
      for (const bp of sale.boughtProducts) {
        if (!boughtProductMatchesFilters(bp, filters)) continue;
        const entry = totals.get(bp.productId) ?? { nome: bp.product.name, valor: 0 };
        entry.valor += bp.value;
        totals.set(bp.productId, entry);
      }
    }

    const totalValue = [...totals.values()].reduce((sum, e) => sum + e.valor, 0);
    return [...totals.values()]
      .map((e) => ({
        produto: e.nome,
        valor: round2(e.valor),
        percentual: totalValue > 0 ? round1((e.valor / totalValue) * 100) : 0,
      }))
      .sort((a, b) => b.valor - a.valor);
  }

  /**
   * Origem = UF do endereço padrão do vendedor; Destino = UF do endereço de entrega da venda.
   * Uma venda com produtos de vendedores diferentes gera uma rota por vendedor, com o valor
   * atribuído (soma dos boughtProducts daquele vendedor nessa venda) — não o valor total da venda.
   */
  private buildOrigemDestino(
    sales: Awaited<ReturnType<DashboardService["getExecutivePeriodSales"]>>,
    filters: SaleFilters
  ): RouteAggregate[] {
    const routes = new Map<string, RouteAggregate>();

    for (const sale of sales) {
      const destino = sale.shippingAddress?.uf ?? UNKNOWN_UF;
      const valorPorVendedor = new Map<string, number>();
      const ufPorVendedor = new Map<string, string>();

      for (const bp of sale.boughtProducts) {
        if (!boughtProductMatchesFilters(bp, filters)) continue;
        const sellerId = bp.product.sellerId;
        valorPorVendedor.set(sellerId, (valorPorVendedor.get(sellerId) ?? 0) + bp.value);
        ufPorVendedor.set(sellerId, bp.product.seller.addresses[0]?.uf ?? UNKNOWN_UF);
      }

      for (const [sellerId, valor] of valorPorVendedor) {
        const origem = ufPorVendedor.get(sellerId) ?? UNKNOWN_UF;
        const key = `${origem}->${destino}`;
        const existing = routes.get(key) ?? { origem, destino, quantidade: 0, valor: 0 };
        existing.quantidade += 1;
        existing.valor += valor;
        routes.set(key, existing);
      }
    }

    return [...routes.values()].map((r) => ({ ...r, valor: round2(r.valor) })).sort((a, b) => b.valor - a.valor);
  }

  private buildPrincipaisCompradores(sales: Awaited<ReturnType<DashboardService["getExecutivePeriodSales"]>>): PartyRanking[] {
    const totals = new Map<string, { nome: string; valor: number }>();
    for (const sale of sales) {
      const entry = totals.get(sale.buyerId) ?? { nome: sale.buyer.name, valor: 0 };
      entry.valor += contractTotalOf(sale);
      totals.set(sale.buyerId, entry);
    }
    return this.rankWithOutros(totals);
  }

  private buildPrincipaisVendedores(
    sales: Awaited<ReturnType<DashboardService["getExecutivePeriodSales"]>>,
    filters: SaleFilters
  ): PartyRanking[] {
    const totals = new Map<string, { nome: string; valor: number }>();
    for (const sale of sales) {
      for (const bp of sale.boughtProducts) {
        if (!boughtProductMatchesFilters(bp, filters)) continue;
        const entry = totals.get(bp.product.sellerId) ?? { nome: bp.product.seller.name, valor: 0 };
        entry.valor += bp.value;
        totals.set(bp.product.sellerId, entry);
      }
    }
    return this.rankWithOutros(totals);
  }

  /** Top N por valor desc + um bucket "Outros" agregando o resto (igual ao mockup). */
  private rankWithOutros(totals: Map<string, { nome: string; valor: number }>): PartyRanking[] {
    const totalValue = [...totals.values()].reduce((sum, e) => sum + e.valor, 0);
    const sorted = [...totals.values()].sort((a, b) => b.valor - a.valor);
    const top = sorted.slice(0, TOP_RANKING_SIZE);
    const rest = sorted.slice(TOP_RANKING_SIZE);
    const restValue = rest.reduce((sum, e) => sum + e.valor, 0);

    const toRanking = (nome: string, valor: number): PartyRanking => ({
      nome,
      faturamento: round2(valor),
      percentualParticipacao: totalValue > 0 ? round1((valor / totalValue) * 100) : 0,
    });

    const result = top.map((e) => toRanking(e.nome, e.valor));
    if (rest.length > 0) result.push(toRanking("Outros", restValue));
    return result;
  }

  /**
   * Status por etapa (10 etapas + terminais Cancelado/Recusado), funil cumulativo em 8 baldes
   * (ver FUNNEL_BUCKETS) e os counters/gargalos derivados da mesma etapa (ver comentário inline abaixo,
   * antes do loop que soma operacoesAtivas/finalizadas/aguardandoPagamento). Faz um único scan leve
   * (sem boughtProducts/Payment.amount) sobre as vendas do período filtrado — precisa ler todas porque
   * a etapa é derivada em código (calculatePipelineStage), não uma coluna do banco — mais 3 counts
   * direcionados (semDocumentos/entregaAtrasada/bloqueadas).
   */
  async getPipelineSummary(
    filter: PipelineDateFilter & SaleFilters = {},
    now: Date = new Date()
  ): Promise<PipelineOverviewSummary> {
    const extraWhere = { ...buildCreatedAtWhere(filter), ...buildSaleFilterWhere(filter) };
    const overdueCutoff = new Date(now.getTime() - PENDING_PAYMENT_OVERDUE_DAYS * 86_400_000);

    const [sales, semDocumentosCount, entregaAtrasadaCount, bloqueadasCount] = await Promise.all([
      this.prisma.saleData.findMany({
        where: extraWhere,
        select: {
          status: true,
          createdAt: true,
          statusChangedAt: true,
          downPaymentCompleted: true,
          paymentCompleted: true,
          shippedAt: true,
          arrivedAt: true,
          actualDeliveryDate: true,
          weightDocumentId: true,
          Payment: { where: { status: "completed" }, select: { phase: true, status: true, updatedAt: true } },
        },
      }),
      this.prisma.saleData.count({ where: documentosPendentesWhere(extraWhere) }),
      this.prisma.saleData.count({ where: entregaAtrasadaWhere(now, extraWhere) }),
      this.prisma.saleData.count({ where: pagamentoVencidoWhere(overdueCutoff, extraWhere) }),
    ]);

    const stageResults = sales.map((sale) => calculatePipelineStage(sale, now));
    const { statusCounts, terminal, funnel } = this.tallyStageResults(stageResults);

    // ativa/finalizada/aguardandoPagamento reaproveitam a MESMA etapa do pipeline (calculatePipelineStage) —
    // stage 10 = finalizada, stage 1 = aguardando pagamento (entrada ainda não confirmada), 2-9 = ativa "em fluxo".
    // Cancelado/Recusado (stage 0) ficam de fora, igual ao funil/statusCounts.
    let operacoesAtivas = 0;
    let finalizadas = 0;
    let aguardandoPagamento = 0;
    for (const stageResult of stageResults) {
      if (stageResult.stage === 10) finalizadas += 1;
      else if (stageResult.stage !== 0) {
        operacoesAtivas += 1;
        if (stageResult.stage === 1) aguardandoPagamento += 1;
      }
    }
    const totalContratos = operacoesAtivas + finalizadas;
    const taxaConversaoPercent = totalContratos > 0 ? round1((finalizadas / totalContratos) * 100) : 0;

    return {
      statusCounts,
      terminal,
      funnel,
      counters: {
        operacoesAtivas,
        finalizadas,
        aguardandoPagamento,
        bloqueadas: bloqueadasCount,
        taxaConversaoPercent,
        totalContratos,
      },
      gargalos: {
        aguardandoPagamento,
        bloqueadas: bloqueadasCount,
        semDocumentos: semDocumentosCount,
        entregaAtrasada: entregaAtrasadaCount,
      },
    };
  }

  /** filterOptions do Pipeline: produto/comprador/vendedor no período (date range picker), + status prontos do funil/bloqueio. */
  async getPipelineFilterOptions(dateFilter: PipelineDateFilter = {}): Promise<PipelineFilterOptions> {
    const catalog = await this.getFilterCatalog(buildCreatedAtWhere(dateFilter));
    return { ...catalog, tiposOperacao: [], status: PIPELINE_STATUS_FILTER_OPTIONS };
  }

  /** Tally puro a partir de PipelineStageResult já calculados — reaproveitado pelo executive-overview
   * (que precisa do mesmo resumo, mas já calcula a etapa de cada venda para outros blocos do dashboard). */
  private tallyStageResults(stageResults: ReturnType<typeof calculatePipelineStage>[]): PipelineSummary {
    const statusCounts: PipelineStatusCount[] = PIPELINE_STAGES.map((s) => ({ ...s, count: 0 }));
    const terminal: PipelineStatusCount[] = [
      { stage: 0, key: "cancelado", label: "Cancelado", count: 0 },
      { stage: 0, key: "recusado_vendedor", label: "Recusado pelo vendedor", count: 0 },
    ];
    const funnel: PipelineFunnelBucket[] = FUNNEL_BUCKETS.map(({ key, label }) => ({ key, label, count: 0 }));

    for (const stageResult of stageResults) {
      if (stageResult.stage === 0) {
        const bucket = terminal.find((t) => t.key === stageResult.key);
        if (bucket) bucket.count += 1;
        continue;
      }

      const bucket = statusCounts.find((s) => s.stage === stageResult.stage);
      if (bucket) bucket.count += 1;
      for (const funnelBucket of FUNNEL_BUCKETS) {
        if (stageResult.stage >= funnelBucket.minStage) {
          const target = funnel.find((f) => f.key === funnelBucket.key)!;
          target.count += 1;
        }
      }
    }

    return { statusCounts, terminal, funnel };
  }

  /**
   * Lista detalhada paginada (produto/vendedor/valor/status/dias na etapa), 1 linha por venda.
   * Só essa consulta carrega boughtProducts/product/seller, e só para a página pedida.
   * Filtro de etapa (stage) exige duas fases, porque a etapa é derivada em código, não uma coluna:
   * 1) scan leve (mesmos campos do summary) para achar os IDs que batem com data+etapa;
   * 2) busca pesada (boughtProducts/product/seller) só dos IDs da página pedida.
   * Sem filtro de etapa, a paginação continua direta no banco (take/skip), sem esse scan extra.
   */
  async getPipelineList(
    params: { page?: number; pageSize?: number; stage?: number[]; blocked?: boolean } & PipelineDateFilter & SaleFilters = {},
    now: Date = new Date()
  ): Promise<PipelineListPage> {
    const page = Math.max(1, params.page ?? 1);
    const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, params.pageSize ?? DEFAULT_PAGE_SIZE));
    const overdueCutoff = new Date(now.getTime() - PENDING_PAYMENT_OVERDUE_DAYS * 86_400_000);
    const saleFilterWhere = buildSaleFilterWhere(params);
    // blocked é um predicado real do banco (Payment pending vencido) — some tranquilamente com os
    // demais filtros, ao contrário de stage (que é derivado em código e por isso precisa do scan leve abaixo).
    const blockedWhere = params.blocked ? pagamentoVencidoWhere(overdueCutoff) : {};
    const createdAtWhere = { ...buildCreatedAtWhere(params), ...saleFilterWhere, ...blockedWhere };

    const heavySelect = {
      id: true,
      orderNumber: true,
      status: true,
      createdAt: true,
      statusChangedAt: true,
      downPaymentCompleted: true,
      paymentCompleted: true,
      shippedAt: true,
      arrivedAt: true,
      actualDeliveryDate: true,
      weightDocumentId: true,
      transportValue: true,
      adjustedContractTotal: true,
      buyerId: true,
      buyer: { select: { name: true } },
      boughtProducts: {
        select: {
          value: true,
          product: { select: { name: true, seller: { select: { name: true } } } },
        },
      },
      // Sem filtro por status aqui (ao contrário do summary): precisamos também dos pending pra
      // decidir o selo "Bloqueada" por linha (ver displayStatusLabel).
      Payment: { select: { phase: true, status: true, updatedAt: true, createdAt: true } },
    } as const;

    let total: number;
    let sales: Awaited<ReturnType<typeof this.prisma.saleData.findMany<{ select: typeof heavySelect }>>>;

    if (params.stage && params.stage.length > 0) {
      const stageSet = new Set(params.stage);

      // Sem startDate, o scan leve fica sem limite superior de idade — impõe uma janela máxima
      // pra manter o comportamento estável independente do volume de vendas.
      const dateWhere = params.startDate
        ? buildCreatedAtWhere(params)
        : buildCreatedAtWhere({
            startDate: new Date(now.getTime() - MAX_STAGE_FILTER_WINDOW_DAYS * 86_400_000),
            endDate: params.endDate,
          });
      const stageFilterWhere = { ...dateWhere, ...saleFilterWhere, ...blockedWhere };

      // stage não depende de Payment (calculatePipelineStage só usa Payment para enteredAt/daysInStage,
      // que aqui não são lidos) — omitir a relação evita I/O e payload desnecessários neste scan.
      const lightRows = await this.prisma.saleData.findMany({
        where: stageFilterWhere,
        orderBy: { orderNumber: "desc" },
        select: {
          id: true,
          status: true,
          createdAt: true,
          statusChangedAt: true,
          downPaymentCompleted: true,
          paymentCompleted: true,
          shippedAt: true,
          arrivedAt: true,
          actualDeliveryDate: true,
          weightDocumentId: true,
        },
      });

      const matchingIds = lightRows
        .filter((row) => stageSet.has(calculatePipelineStage(row, now).stage))
        .map((row) => row.id);

      total = matchingIds.length;
      const pageIds = matchingIds.slice((page - 1) * pageSize, (page - 1) * pageSize + pageSize);

      const heavyRows = await this.prisma.saleData.findMany({ where: { id: { in: pageIds } }, select: heavySelect });
      const byId = new Map(heavyRows.map((row) => [row.id, row]));
      sales = pageIds.map((id) => byId.get(id)!);
    } else {
      [total, sales] = await Promise.all([
        this.prisma.saleData.count({ where: createdAtWhere }),
        this.prisma.saleData.findMany({
          where: createdAtWhere,
          orderBy: { orderNumber: "desc" },
          skip: (page - 1) * pageSize,
          take: pageSize,
          select: heavySelect,
        }),
      ]);
    }

    const items: PipelineListItem[] = sales.map((sale) => {
      const stageResult = calculatePipelineStage(sale, now);
      // !sale.paymentCompleted: mesma exclusão de pagamentoVencidoWhere — uma venda já paga (etapa 9/10)
      // pode ter um Payment 'pending' órfão de uma tentativa antiga/alternativa; sem isso ela apareceria
      // como "Bloqueada" mesmo já finalizada.
      const isBlocked = !sale.paymentCompleted && sale.Payment.some((p) => p.status === "pending" && p.createdAt < overdueCutoff);
      const products = sale.boughtProducts;
      const produto = products.length === 0
        ? "-"
        : products.length === 1
          ? products[0].product.name
          : `${products[0].product.name} (+${products.length - 1})`;
      const sellerNames = [...new Set(products.map((bp) => bp.product.seller.name))];
      const vendedor = sellerNames.length === 0 ? "-" : sellerNames.length === 1 ? sellerNames[0] : "Múltiplos vendedores";

      return {
        id: sale.id,
        orderNumber: sale.orderNumber,
        produto,
        comprador: sale.buyer.name,
        vendedor,
        valor: round2(contractTotalOf(sale)),
        status: displayStatusLabel(stageResult, isBlocked),
        diasEtapa: stageResult.daysInStage,
      };
    });

    return { items, page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)) };
  }

  /**
   * Dataset LEVE de cada regra — só id + os campos de data-gatilho, sem relações pesadas (buyer,
   * boughtProducts, operationDocuments). Usado pra counts/criticos-medios/porCategoria/evolucaoMensal/
   * alertedSaleIds, que precisam de TODAS as linhas abertas mas não de detalhe nenhum — sem `take`
   * porque essas agregações genuinamente precisam do total, mas o select mínimo evita o scan pesado
   * (era o ponto problemático da versão anterior: buscava as relações completas pra cada linha aberta).
   * A relação Payment só é buscada pra pagamentoVencido (única regra que precisa dela pra achar a data-
   * gatilho) — nas outras 3, incluir esse join em toda linha aberta seria custo puro sem uso nenhum.
   */
  private async fetchAlertTriggerRows(rule: AlertRuleKey, where: Record<string, unknown>): Promise<AlertTriggerRow[]> {
    if (rule === "pagamentoVencido") {
      return this.prisma.saleData.findMany({
        where,
        select: {
          id: true,
          plannedHarvestDate: true,
          shippedAt: true,
          plannedDeliveryDate: true,
          Payment: { where: { status: "pending" }, select: { createdAt: true }, orderBy: { createdAt: "asc" }, take: 1 },
        },
      });
    }

    const rows = await this.prisma.saleData.findMany({
      where,
      select: { id: true, plannedHarvestDate: true, shippedAt: true, plannedDeliveryDate: true },
    });
    return rows.map((row) => ({ ...row, Payment: [] }));
  }

  /** Dataset PESADO (buyer/boughtProducts/operationDocuments/weightDocumentId) — só pros ids que efetivamente entram em list.items (no máximo `limit`), nunca pro dataset aberto inteiro. */
  private async fetchAlertDetailRows(ids: string[]) {
    return this.prisma.saleData.findMany({
      where: { id: { in: ids } },
      select: {
        id: true,
        orderNumber: true,
        buyerId: true,
        buyer: { select: { name: true } },
        plannedHarvestDate: true,
        shippedAt: true,
        plannedDeliveryDate: true,
        weightDocumentId: true,
        boughtProducts: { select: { product: { select: { seller: { select: { name: true } } } } } },
        operationDocuments: { where: { docType: "nota_fiscal" }, select: { id: true }, take: 1 },
        Payment: { where: { status: "pending" }, select: { createdAt: true }, orderBy: { createdAt: "asc" }, take: 1 },
      },
    });
  }

  /** Data em que a condição do alerta passou a valer — base de diasEmAberto e do bucket mensal em evolucaoMensal. Aceita linha leve ou pesada (mesmos campos de data em ambas). */
  private pickAlertTriggerDate(rule: AlertRuleKey, row: AlertTriggerRow): Date {
    switch (rule) {
      case "semPagamentoAntesColheita":
        return row.plannedHarvestDate as Date;
      case "documentosPendentes":
        return row.shippedAt as Date;
      case "entregaAtrasada":
        return row.plannedDeliveryDate as Date;
      case "pagamentoVencido":
        // pagamentoVencidoWhere garante ao menos 1 Payment pending vencido; a mais antiga é o gatilho mais conservador.
        return row.Payment[0].createdAt;
    }
  }

  private buildAlertDescricao(
    rule: AlertRuleKey,
    row: Awaited<ReturnType<DashboardService["fetchAlertDetailRows"]>>[number],
    triggerDate: Date
  ): string {
    const fmt = (d: Date) => d.toLocaleDateString("pt-BR", { timeZone: "UTC" });
    switch (rule) {
      case "semPagamentoAntesColheita":
        return `Pagamento não confirmado antes da colheita (planejada para ${fmt(triggerDate)}).`;
      case "documentosPendentes": {
        const semNota = row.operationDocuments.length === 0;
        const semPesagem = !row.weightDocumentId;
        if (semNota && semPesagem) return "Nota fiscal e comprovante de pesagem não enviados após embarque.";
        if (semNota) return "Nota fiscal não enviada após embarque.";
        return "Comprovante de pesagem não enviado após embarque.";
      }
      case "entregaAtrasada":
        return `Entrega prevista para ${fmt(triggerDate)} não realizada.`;
      case "pagamentoVencido":
        return `Pagamento pendente vencido — aberto desde ${fmt(triggerDate)}.`;
    }
  }

  private sellerNamesOfAlertRow(row: Awaited<ReturnType<DashboardService["fetchAlertDetailRows"]>>[number]): string {
    const names = [...new Set(row.boughtProducts.map((bp) => bp.product.seller.name))];
    return names.length === 0 ? "-" : names.length === 1 ? names[0] : "Múltiplos vendedores";
  }

  private buildAlertItem(
    rule: AlertRuleKey,
    row: Awaited<ReturnType<DashboardService["fetchAlertDetailRows"]>>[number],
    now: Date
  ): OperationalAlertItem {
    const meta = ALERT_RULE_META[rule];
    const triggerDate = this.pickAlertTriggerDate(rule, row);
    const parceiro = meta.responsavel === "Comprador" ? row.buyer.name : this.sellerNamesOfAlertRow(row);
    return {
      id: row.id,
      orderNumber: row.orderNumber,
      categoria: meta.categoria,
      criticidade: meta.criticidade,
      parceiro,
      descricao: this.buildAlertDescricao(rule, row, triggerDate),
      dataHora: triggerDate.toISOString(),
      diasEmAberto: daysBetween(triggerDate, now),
      acao: meta.acao,
      status: "Aberto" as const,
    };
  }

  /**
   * "Resolvido" é uma APROXIMAÇÃO combinada com o time (sem tabela de histórico de alertas — decisão
   * registrada, ver resumo de pendência): infere o momento da resolução a partir de timestamps que já
   * existem (confirmação de pagamento, upload de documento, entrega registrada). Funciona bem pra
   * semPagamentoAntesColheita/documentosPendentes/entregaAtrasada; pagamentoVencido é a mais aproximada,
   * porque Payment não guarda histórico de mudança de status — só a última atualização (updatedAt).
   */
  private async countResolvedInPeriod(
    rule: AlertRuleKey,
    windowStart: Date,
    windowEnd: Date,
    saleWhere: Record<string, unknown>
  ): Promise<number> {
    switch (rule) {
      case "semPagamentoAntesColheita": {
        // Payment não é único por venda (down_payment + full, ou reprocessamentos) — dedup por saleId,
        // senão uma venda com mais de um Payment completed no período conta como "resolvida" várias vezes.
        const rows = await this.prisma.payment.findMany({
          where: {
            phase: { in: ["down_payment", "full"] },
            status: "completed",
            updatedAt: { gte: windowStart, lt: windowEnd },
            sale: saleWhere,
          },
          select: { saleId: true, updatedAt: true, sale: { select: { plannedHarvestDate: true } } },
        });
        const resolvedSaleIds = new Set(
          rows.filter((p) => p.sale.plannedHarvestDate && p.updatedAt >= p.sale.plannedHarvestDate).map((p) => p.saleId)
        );
        return resolvedSaleIds.size;
      }
      case "documentosPendentes": {
        // documentosPendentesWhere é um OR (sem NF OU sem pesagem) — "resolvido" só quando os DOIS
        // documentos existem hoje, não quando só um dos dois teve upload na janela (senão uma venda que
        // ainda ficou com um documento pendente conta como resolvida). Por isso o filtro checa o estado
        // ATUAL da venda (tem NF e weightDocumentId) além do evento de upload ter caído na janela.
        const rows = await this.prisma.operationDocument.findMany({
          where: { docType: { in: ["nota_fiscal", "ticket_balanca"] }, uploadedAt: { gte: windowStart, lt: windowEnd }, sale: saleWhere },
          select: {
            saleId: true,
            uploadedAt: true,
            sale: {
              select: {
                shippedAt: true,
                weightDocumentId: true,
                operationDocuments: { where: { docType: "nota_fiscal" }, select: { id: true }, take: 1 },
              },
            },
          },
        });
        const resolvedSaleIds = new Set(
          rows
            .filter(
              (d) =>
                d.sale.shippedAt &&
                d.uploadedAt > d.sale.shippedAt &&
                d.sale.weightDocumentId &&
                d.sale.operationDocuments.length > 0
            )
            .map((d) => d.saleId)
        );
        return resolvedSaleIds.size;
      }
      case "entregaAtrasada": {
        const rows = await this.prisma.saleData.findMany({
          where: { actualDeliveryDate: { gte: windowStart, lt: windowEnd }, plannedDeliveryDate: { not: null }, ...saleWhere },
          select: { actualDeliveryDate: true, plannedDeliveryDate: true },
        });
        return rows.filter((s) => s.actualDeliveryDate! > s.plannedDeliveryDate!).length;
      }
      case "pagamentoVencido": {
        // Mesmo motivo de semPagamentoAntesColheita: dedup por saleId contra múltiplos Payment completed.
        const rows = await this.prisma.payment.findMany({
          where: { status: "completed", updatedAt: { gte: windowStart, lt: windowEnd }, sale: saleWhere },
          select: { saleId: true, createdAt: true, updatedAt: true },
        });
        const resolvedSaleIds = new Set(
          rows.filter((p) => diffInDays(p.createdAt, p.updatedAt) > PENDING_PAYMENT_OVERDUE_DAYS).map((p) => p.saleId)
        );
        return resolvedSaleIds.size;
      }
    }
  }

  /**
   * Índice de Saúde Operacional = % de operações ATIVAS (etapa 1-9, mesma régua de calculatePipelineStage
   * usada no Pipeline) sem nenhum alerta das regras ativas no momento — decisão confirmada com o time,
   * em vez de "% de alertas resolvidos" (essa dependeria da aproximação sem histórico de countResolvedInPeriod).
   * Não depende de histórico, funciona com o estado atual. Respeita os mesmos filtros de período/parceiro
   * do restante do endpoint; se categoria/criticidade filtrarem pra só algumas regras, o índice reflete a
   * saúde SÓ daquelas regras (ex.: filtrando categoria=Financeiro, mostra "% sem alerta financeiro ativo").
   * null quando não há nenhuma operação ativa no escopo filtrado (nada pra medir).
   */
  private async computeSaudeOperacionalPercent(
    saleWhere: Record<string, unknown>,
    alertedSaleIds: Set<string>,
    now: Date
  ): Promise<number | null> {
    // status excluído direto na query: Cancelado/Recusado sempre dão stage 0 (calculatePipelineStage),
    // então entrariam e sairiam do filtro de qualquer forma — excluir aqui evita ler/trazer essas linhas
    // à toa quando não há filtro de período/parceiro (onde o volume pode ser grande).
    // Sem createdAt explícito (startDate/endDate ausentes), limita aos últimos MAX_STAGE_FILTER_WINDOW_DAYS
    // dias — mesma janela de segurança que o scan leve de stage do Pipeline já usa (getPipelineList) pro
    // mesmo problema: sem isso, o índice de saúde vira um scan do histórico inteiro de vendas. Uma
    // operação "ativa" (etapa 1-9) genuinamente parada por mais tempo que isso é caso raro — fica de
    // fora da conta (numerador e denominador) em vez de forçar o scan completo.
    const hasExplicitPeriod = "createdAt" in saleWhere;
    const boundedSaleWhere = hasExplicitPeriod
      ? saleWhere
      : { ...saleWhere, createdAt: { gte: new Date(now.getTime() - MAX_STAGE_FILTER_WINDOW_DAYS * 86_400_000) } };

    const sales = await this.prisma.saleData.findMany({
      where: { ...boundedSaleWhere, status: ACTIVE_SALE_STATUS_FILTER },
      select: {
        id: true,
        status: true,
        createdAt: true,
        statusChangedAt: true,
        downPaymentCompleted: true,
        paymentCompleted: true,
        shippedAt: true,
        arrivedAt: true,
        actualDeliveryDate: true,
        weightDocumentId: true,
        Payment: { where: { status: "completed" }, select: { phase: true, status: true, updatedAt: true } },
      },
    });

    const activeIds = sales
      .filter((sale) => {
        const stage = calculatePipelineStage(sale, now).stage;
        return stage >= 1 && stage <= 9;
      })
      .map((sale) => sale.id);

    if (activeIds.length === 0) return null;

    const comAlerta = activeIds.filter((id) => alertedSaleIds.has(id)).length;
    return round1(((activeIds.length - comAlerta) / activeIds.length) * 100);
  }

  /**
   * Últimos 6 meses corridos (independente do filtro de período da página — é uma retrospectiva fixa,
   * igual ao "últimos 12 meses" do executive-overview). criticos/medios reaproveitam as MESMAS linhas já
   * buscadas pros contadores atuais (bucketadas pela data-gatilho); resolvidos roda countResolvedInPeriod
   * por mês — só pras regras ativas no filtro de categoria/criticidade da chamada.
   */
  private async computeEvolucaoMensal(
    now: Date,
    overdueCutoff: Date,
    activeRules: AlertRuleKey[],
    parceiroWhere: Record<string, unknown>
  ): Promise<AlertMonthlyPoint[]> {
    const months = buildLastMonths(now, EVOLUTION_MONTHS);
    const saleWhereForResolved = { ...parceiroWhere, status: ACTIVE_SALE_STATUS_FILTER };

    // Retrospectiva FIXA de 6 meses — busca as linhas abertas de novo, com o MESMO filtro de parceiro
    // da chamada mas SEM o createdAt de startDate/endDate (que é ad-hoc da página). Reaproveitar o
    // openRowsByRule do resto do endpoint faria criticos/medios encolherem junto com o filtro de
    // período, contradizendo a doc do endpoint (evolucaoMensal é pra ser independente disso).
    const ruleWhereForEvolution: Record<AlertRuleKey, Record<string, unknown>> = {
      semPagamentoAntesColheita: semPagamentoAntesColheitaWhere(now, parceiroWhere),
      documentosPendentes: documentosPendentesWhere(parceiroWhere),
      entregaAtrasada: entregaAtrasadaWhere(now, parceiroWhere),
      pagamentoVencido: pagamentoVencidoWhere(overdueCutoff, parceiroWhere),
    };
    const openRowsEntries = await Promise.all(
      activeRules.map(async (rule) => [rule, await this.fetchAlertTriggerRows(rule, ruleWhereForEvolution[rule])] as const)
    );
    const openRowsByRule = new Map(openRowsEntries);

    return Promise.all(
      months.map(async ({ key, label, start, end }) => {
        let criticos = 0;
        let medios = 0;
        for (const rule of activeRules) {
          const rows = openRowsByRule.get(rule) ?? [];
          const meta = ALERT_RULE_META[rule];
          const countInMonth = rows.filter((row) => {
            const triggerDate = this.pickAlertTriggerDate(rule, row);
            return triggerDate >= start && triggerDate < end;
          }).length;
          if (meta.criticidade === "Crítico") criticos += countInMonth;
          else if (meta.criticidade === "Médio") medios += countInMonth;
        }

        const resolvedCounts = await Promise.all(
          activeRules.map((rule) => this.countResolvedInPeriod(rule, start, end, saleWhereForResolved))
        );

        return { month: key, label, criticos, medios, resolvidos: resolvedCounts.reduce((sum, c) => sum + c, 0) };
      })
    );
  }

  /**
   * Alertas Operacionais — 4 regras reais (semPagamentoAntesColheita, documentosPendentes,
   * entregaAtrasada, pagamentoVencido) + semTermoAditivo em standby (sempre 0 — ver resumo de
   * pendência entregue ao time). categoria/criticidade filtram QUAIS regras entram na conta (fixas por
   * tipo de regra, não por venda); período/parceiro filtram as vendas de cada regra.
   * saudeOperacionalPercent é calculado por computeSaudeOperacionalPercent (null só quando não há
   * nenhuma operação ativa no escopo filtrado — ver o comentário daquele método).
   * A lista final é buscada em duas fases (fetchAlertTriggerRows leve pra todas as linhas abertas,
   * fetchAlertDetailRows pesado só pros ids que entram em list.items) — ver comentário de cada uma.
   */
  async getOperationalAlerts(
    params: { limit?: number } & PipelineDateFilter & AlertFilters = {},
    now: Date = new Date()
  ): Promise<OperationalAlertsOverview> {
    const limit = Math.min(MAX_ALERT_LIST_LIMIT, Math.max(1, params.limit ?? DEFAULT_ALERT_LIST_LIMIT));
    const overdueCutoff = new Date(now.getTime() - PENDING_PAYMENT_OVERDUE_DAYS * 86_400_000);

    const parceiroWhere = buildParceiroWhere(params.parceiroId);
    const dateWhere = buildCreatedAtWhere(params);
    const extraWhere = { ...dateWhere, ...parceiroWhere };

    const activeRules = ALERT_RULE_KEYS.filter((rule) => {
      const meta = ALERT_RULE_META[rule];
      if (params.categoria && meta.categoria !== params.categoria) return false;
      if (params.criticidade && meta.criticidade !== params.criticidade) return false;
      return true;
    });

    const ruleWhere: Record<AlertRuleKey, Record<string, unknown>> = {
      semPagamentoAntesColheita: semPagamentoAntesColheitaWhere(now, extraWhere),
      documentosPendentes: documentosPendentesWhere(extraWhere),
      entregaAtrasada: entregaAtrasadaWhere(now, extraWhere),
      pagamentoVencido: pagamentoVencidoWhere(overdueCutoff, extraWhere),
    };

    const openRowsEntries = await Promise.all(
      activeRules.map(async (rule) => [rule, await this.fetchAlertTriggerRows(rule, ruleWhere[rule])] as const)
    );
    const openRowsByRule = new Map(openRowsEntries);

    const counts: OperationalAlertCounts = {
      semPagamentoAntesColheita: openRowsByRule.get("semPagamentoAntesColheita")?.length ?? 0,
      documentosPendentes: openRowsByRule.get("documentosPendentes")?.length ?? 0,
      entregaAtrasada: openRowsByRule.get("entregaAtrasada")?.length ?? 0,
      bloqueadas: openRowsByRule.get("pagamentoVencido")?.length ?? 0,
      semTermoAditivo: 0,
    };

    let criticos = 0;
    let medios = 0;
    for (const rule of activeRules) {
      const meta = ALERT_RULE_META[rule];
      const count = openRowsByRule.get(rule)?.length ?? 0;
      if (meta.criticidade === "Crítico") criticos += count;
      else if (meta.criticidade === "Médio") medios += count;
    }

    // Sem startDate, a janela termina em endDate (ou now, se nenhum dos dois vier) e começa
    // DEFAULT_RESOLVED_WINDOW_DAYS antes DESSE fim — nunca "now - 30 dias" fixo, senão uma consulta só
    // com endDate no passado fica com uma janela que não termina em endDate (incoerente).
    const resolvedWindowEnd = params.endDate ?? now;
    const resolvedWindowStart = params.startDate ?? new Date(resolvedWindowEnd.getTime() - DEFAULT_RESOLVED_WINDOW_DAYS * 86_400_000);
    const saleWhereForResolved = { ...parceiroWhere, status: ACTIVE_SALE_STATUS_FILTER };

    const alertedSaleIds = new Set<string>();
    for (const rule of activeRules) {
      for (const row of openRowsByRule.get(rule) ?? []) alertedSaleIds.add(row.id);
    }

    const [resolvedCounts, saudeOperacionalPercent] = await Promise.all([
      Promise.all(activeRules.map((rule) => this.countResolvedInPeriod(rule, resolvedWindowStart, resolvedWindowEnd, saleWhereForResolved))),
      this.computeSaudeOperacionalPercent(extraWhere, alertedSaleIds, now),
    ]);
    const resolvidos = resolvedCounts.reduce((sum, c) => sum + c, 0);

    const porCategoriaTotals = new Map<AlertCategoria, number>([
      ["Financeiro", 0],
      ["Documentação", 0],
      ["Logística", 0],
      ["Contratual", 0],
      ["Outros", 0],
    ]);
    for (const rule of activeRules) {
      const meta = ALERT_RULE_META[rule];
      porCategoriaTotals.set(meta.categoria, (porCategoriaTotals.get(meta.categoria) ?? 0) + (openRowsByRule.get(rule)?.length ?? 0));
    }
    const porCategoriaTotal = [...porCategoriaTotals.values()].reduce((sum, v) => sum + v, 0);
    const porCategoria: AlertCategoryBreakdown[] = [...porCategoriaTotals.entries()].map(([categoria, count]) => ({
      categoria,
      count,
      percentual: porCategoriaTotal > 0 ? round1((count / porCategoriaTotal) * 100) : 0,
    }));

    const evolucaoMensal = await this.computeEvolucaoMensal(now, overdueCutoff, activeRules, parceiroWhere);

    // Ordena pelas linhas LEVES (sem buscar relação pesada nenhuma) — criticidade primeiro, e dentro da
    // mesma criticidade, MAIOR diasEmAberto primeiro (quem está aberto há mais tempo é mais urgente numa
    // lista acionável). Só depois de decidir os `limit` primeiros é que busca o detalhe pesado deles.
    const CRITICIDADE_RANK: Record<AlertCriticidade, number> = { "Crítico": 0, "Médio": 1, "Baixo": 2 };
    const rankedRefs = activeRules.flatMap((rule) =>
      (openRowsByRule.get(rule) ?? []).map((row) => ({
        rule,
        id: row.id,
        criticidade: ALERT_RULE_META[rule].criticidade,
        diasEmAberto: daysBetween(this.pickAlertTriggerDate(rule, row), now),
      }))
    );
    rankedRefs.sort((a, b) => CRITICIDADE_RANK[a.criticidade] - CRITICIDADE_RANK[b.criticidade] || b.diasEmAberto - a.diasEmAberto);
    const total = rankedRefs.length;
    const topRefs = rankedRefs.slice(0, limit);

    const detailRows = topRefs.length > 0 ? await this.fetchAlertDetailRows([...new Set(topRefs.map((r) => r.id))]) : [];
    const detailById = new Map(detailRows.map((row) => [row.id, row]));
    const items: OperationalAlertItem[] = topRefs
      .map((ref) => {
        const row = detailById.get(ref.id);
        return row ? this.buildAlertItem(ref.rule, row, now) : null;
      })
      .filter((item): item is OperationalAlertItem => item !== null);

    const filterCatalog = await this.getFilterCatalog(dateWhere);
    const parceirosMap = new Map<string, string>();
    for (const p of [...filterCatalog.compradores, ...filterCatalog.vendedores]) parceirosMap.set(p.id, p.name);
    const parceiros = [...parceirosMap.entries()]
      .map(([id, name]) => ({ id, name }))
      .sort((a, b) => a.name.localeCompare(b.name, "pt-BR"));

    return {
      counters: { criticos, medios, resolvidos, bloqueadas: counts.bloqueadas, saudeOperacionalPercent },
      counts,
      porCategoria,
      evolucaoMensal,
      filterOptions: {
        categorias: [...ALERT_CATEGORIAS],
        criticidades: [...ALERT_CRITICIDADES],
        parceiros,
      },
      list: { items, total, limit },
    };
  }

  /**
   * Logística e Desempenho: tempo médio de entrega (shippedAt → actualDeliveryDate), % no prazo e
   * atraso médio (plannedDeliveryDate x actualDeliveryDate), + desempenho por comprador/vendedor.
   * Considera só vendas efetivamente entregues (actualDeliveryDate preenchido), fora Canceladas/Recusadas.
   */
  async getLogisticsOverview(): Promise<LogisticsOverview> {
    const deliveredSales = await this.prisma.saleData.findMany({
      where: { actualDeliveryDate: { not: null }, status: ACTIVE_SALE_STATUS_FILTER },
      select: {
        shippedAt: true,
        actualDeliveryDate: true,
        plannedDeliveryDate: true,
        buyerId: true,
        buyer: { select: { name: true } },
        boughtProducts: {
          select: { product: { select: { sellerId: true, seller: { select: { name: true } } } } },
        },
      },
    });

    const deliveryDurations: number[] = [];
    const delayDurations: number[] = [];
    let onTimeCount = 0;
    let onTimeEligibleCount = 0;

    const buyerStats = new Map<string, { name: string; delivered: number; onTime: number }>();
    const sellerStats = new Map<string, { name: string; delivered: number; onTime: number }>();

    for (const sale of deliveredSales) {
      const actualDeliveryDate = sale.actualDeliveryDate as Date;

      if (sale.shippedAt) {
        deliveryDurations.push(diffInDays(sale.shippedAt, actualDeliveryDate));
      }

      if (sale.plannedDeliveryDate) {
        onTimeEligibleCount += 1;
        const isOnTime = actualDeliveryDate <= sale.plannedDeliveryDate;
        if (isOnTime) onTimeCount += 1;
        else delayDurations.push(diffInDays(sale.plannedDeliveryDate, actualDeliveryDate));

        const buyerEntry = buyerStats.get(sale.buyerId) ?? { name: sale.buyer.name, delivered: 0, onTime: 0 };
        buyerEntry.delivered += 1;
        if (isOnTime) buyerEntry.onTime += 1;
        buyerStats.set(sale.buyerId, buyerEntry);

        const sellerNameById = new Map<string, string>();
        for (const bp of sale.boughtProducts) {
          sellerNameById.set(bp.product.sellerId, bp.product.seller.name);
        }
        for (const [sellerId, sellerName] of sellerNameById) {
          const sellerEntry = sellerStats.get(sellerId) ?? { name: sellerName, delivered: 0, onTime: 0 };
          sellerEntry.delivered += 1;
          if (isOnTime) sellerEntry.onTime += 1;
          sellerStats.set(sellerId, sellerEntry);
        }
      }
    }

    const toPerformanceList = (stats: Map<string, { name: string; delivered: number; onTime: number }>): LogisticsPartyPerformance[] =>
      [...stats.entries()]
        .map(([id, s]) => {
          const onTimePercent = round1((s.onTime / s.delivered) * 100);
          return { id, name: s.name, delivered: s.delivered, onTimePercent, alerta: onTimePercent < ON_TIME_ALERT_THRESHOLD_PERCENT };
        })
        .sort((a, b) => a.onTimePercent - b.onTimePercent);

    const avgDeliveryDays = average(deliveryDurations);
    const avgDelayDays = average(delayDurations);

    return {
      deliveredCount: deliveredSales.length,
      averageDeliveryDays: avgDeliveryDays !== null ? round1(avgDeliveryDays) : null,
      onTimePercent: onTimeEligibleCount > 0 ? round1((onTimeCount / onTimeEligibleCount) * 100) : null,
      averageDelayDays: avgDelayDays !== null ? round1(avgDelayDays) : null,
      byBuyer: toPerformanceList(buyerStats),
      bySeller: toPerformanceList(sellerStats),
    };
  }
}
