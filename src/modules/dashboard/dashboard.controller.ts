import { Request, Response, RequestHandler } from "express";
import { DashboardService, ALERT_CATEGORIAS, ALERT_CRITICIDADES, AlertCategoria, AlertCriticidade } from "./dashboard.service";

const service = new DashboardService();

/** Retorna undefined se ausente, o inteiro positivo se válido, ou "invalid" se presente e malformado. */
function parsePositiveIntParam(raw: unknown): number | undefined | "invalid" {
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : "invalid";
}

/** Retorna undefined se ausente, a Date se válida, ou "invalid" se presente e não parseável. */
/** "" (ex.: ?startDate= com o campo limpo no front) é tratado como ausente, não como data inválida. */
function parseDateParam(raw: unknown): Date | undefined | "invalid" {
  if (raw === undefined || raw === "") return undefined;
  const date = new Date(raw as string);
  return Number.isNaN(date.getTime()) ? "invalid" : date;
}

/** Lista separada por vírgula de inteiros 0-10 (0 = terminal Cancelado/Recusado, 1-10 = etapas do pipeline). */
function parseStageListParam(raw: unknown): number[] | undefined | "invalid" {
  if (raw === undefined) return undefined;
  const parts = String(raw).split(",").map((p) => p.trim()).filter(Boolean);
  if (parts.length === 0) return undefined;
  const stages = parts.map(Number);
  const allValid = stages.every((s) => Number.isInteger(s) && s >= 0 && s <= 10);
  return allValid ? stages : "invalid";
}

/** Retorna undefined se ausente/vazio, ou a string se presente (query params de filtro são sempre IDs). */
function parseOptionalStringParam(raw: unknown): string | undefined {
  if (typeof raw !== "string" || raw.trim() === "") return undefined;
  return raw;
}

/** Retorna undefined se ausente, o valor se estiver na lista permitida, ou "invalid" se presente e fora dela. */
function parseEnumParam<T extends string>(raw: unknown, allowed: readonly T[]): T | undefined | "invalid" {
  if (raw === undefined) return undefined;
  return (allowed as readonly string[]).includes(raw as string) ? (raw as T) : "invalid";
}

/** Retorna undefined se ausente, o boolean se "true"/"false", ou "invalid" se presente e diferente disso. */
function parseBooleanParam(raw: unknown): boolean | undefined | "invalid" {
  if (raw === undefined) return undefined;
  if (raw === "true") return true;
  if (raw === "false") return false;
  return "invalid";
}

export class DashboardController {
  public getExecutiveOverview: RequestHandler = async (req: Request, res: Response): Promise<void> => {
    try {
      const filters = {
        produtoId: parseOptionalStringParam(req.query.produto),
        compradorId: parseOptionalStringParam(req.query.comprador),
        vendedorId: parseOptionalStringParam(req.query.vendedor),
        tipoOperacao: parseOptionalStringParam(req.query.tipoOperacao),
      };
      const result = await service.getExecutiveOverview(filters);
      res.status(200).json(result);
    } catch (error: any) {
      console.error(error);
      res.status(500).json({ error: "Failed to load executive overview" });
    }
  };

  public getPipelineOverview: RequestHandler = async (req: Request, res: Response): Promise<void> => {
    try {
      const page = parsePositiveIntParam(req.query.page);
      const pageSize = parsePositiveIntParam(req.query.pageSize);
      const startDate = parseDateParam(req.query.startDate);
      const endDate = parseDateParam(req.query.endDate);
      const stage = parseStageListParam(req.query.stage);
      const blocked = parseBooleanParam(req.query.blocked);

      if (page === "invalid" || pageSize === "invalid") {
        res.status(400).json({ error: "page e pageSize devem ser números inteiros positivos" });
        return;
      }
      if (startDate === "invalid" || endDate === "invalid") {
        res.status(400).json({ error: "startDate e endDate devem ser datas válidas (ISO 8601)" });
        return;
      }
      if (stage === "invalid") {
        res.status(400).json({ error: "stage deve ser uma lista de inteiros entre 0 e 10 separados por vírgula" });
        return;
      }
      if (blocked === "invalid") {
        res.status(400).json({ error: "blocked deve ser 'true' ou 'false'" });
        return;
      }

      const now = new Date();
      const dateFilter = { startDate, endDate };
      const filters = {
        produtoId: parseOptionalStringParam(req.query.produto),
        compradorId: parseOptionalStringParam(req.query.comprador),
        vendedorId: parseOptionalStringParam(req.query.vendedor),
        tipoOperacao: parseOptionalStringParam(req.query.tipoOperacao),
      };

      const [summary, list, filterOptions] = await Promise.all([
        service.getPipelineSummary({ ...dateFilter, ...filters }, now),
        service.getPipelineList({ page, pageSize, stage, blocked, ...dateFilter, ...filters }, now),
        service.getPipelineFilterOptions(dateFilter),
      ]);

      res.status(200).json({ ...summary, filterOptions, list });
    } catch (error: any) {
      console.error(error);
      res.status(500).json({ error: "Failed to load pipeline overview" });
    }
  };

  public getOperationalAlerts: RequestHandler = async (req: Request, res: Response): Promise<void> => {
    try {
      const limit = parsePositiveIntParam(req.query.limit);
      const startDate = parseDateParam(req.query.startDate);
      const endDate = parseDateParam(req.query.endDate);
      const categoria = parseEnumParam<AlertCategoria>(req.query.categoria, ALERT_CATEGORIAS);
      const criticidade = parseEnumParam<AlertCriticidade>(req.query.criticidade, ALERT_CRITICIDADES);
      const parceiroId = parseOptionalStringParam(req.query.parceiro);

      if (limit === "invalid") {
        res.status(400).json({ error: "limit deve ser um número inteiro positivo" });
        return;
      }
      if (startDate === "invalid" || endDate === "invalid") {
        res.status(400).json({ error: "startDate e endDate devem ser datas válidas (ISO 8601)" });
        return;
      }
      if (categoria === "invalid") {
        res.status(400).json({ error: `categoria deve ser uma de: ${ALERT_CATEGORIAS.join(", ")}` });
        return;
      }
      if (criticidade === "invalid") {
        res.status(400).json({ error: `criticidade deve ser uma de: ${ALERT_CRITICIDADES.join(", ")}` });
        return;
      }

      const result = await service.getOperationalAlerts({ limit, startDate, endDate, categoria, criticidade, parceiroId });
      res.status(200).json(result);
    } catch (error: any) {
      console.error(error);
      res.status(500).json({ error: "Failed to load operational alerts" });
    }
  };

  public getLogisticsOverview: RequestHandler = async (_req: Request, res: Response): Promise<void> => {
    try {
      const result = await service.getLogisticsOverview();
      res.status(200).json(result);
    } catch (error: any) {
      console.error(error);
      res.status(500).json({ error: "Failed to load logistics overview" });
    }
  };
}
