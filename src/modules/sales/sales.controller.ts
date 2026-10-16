import { Request, Response, RequestHandler } from "express";
import { SaleService } from "./sales.service";
import { CreateSaleDataDto, SellerDecisionDto, UpdateSaleDataDto } from "./dto/create-sales.dto";
import { UploadS3Service } from "../upload-S3/uploadS3.service";

const service = new SaleService();
const s3Service = new UploadS3Service();

type SaleAccess = { found: boolean; role: "admin" | "buyer" | "seller" | null };

/**
 * Campos de UpdateSaleDataDto que comprador/vendedor podem alterar via PUT /sales/:id.
 * Tudo que envolve dinheiro, identidade da venda, máquina de estados ou conteúdo do
 * pedido (buyerId, paymentCompleted, paymentMethodId, status, sellerApproved,
 * boughtProducts, transportValue, cargoWeightKg etc.) já tem endpoint dedicado com
 * suas próprias travas e não deve ser mutável por aqui — só admin tem acesso irrestrito.
 */
const PARTY_EDITABLE_SALE_FIELDS = [
  "addressId",
  "productRating",
  "sellerRating",
  "plannedHarvestDate",
  "plannedPickupDate",
  "plannedDeliveryDate",
  "technicalSpec",
  "certifierRequired",
] as const;

function sanitizeSaleUpdatePayload(role: "admin" | "buyer" | "seller", body: Record<string, unknown>) {
  if (role === "admin") return body;

  const sanitized: Record<string, unknown> = {};
  for (const field of PARTY_EDITABLE_SALE_FIELDS) {
    if (body[field] !== undefined) sanitized[field] = body[field];
  }
  return sanitized;
}

/** Verifica se o usuário autenticado é admin, o comprador ou um dos vendedores da venda. */
async function getSaleAccess(req: Request, saleId: string): Promise<SaleAccess> {
  const parties = await service.getSaleParties(saleId);
  if (!parties) return { found: false, role: null };

  if (req.user?.role === "admin") return { found: true, role: "admin" };
  if (parties.buyerId === req.user?.userId) return { found: true, role: "buyer" };
  if (req.user?.userId && parties.sellerIds.includes(req.user.userId)) {
    return { found: true, role: "seller" };
  }
  return { found: true, role: null };
}

export class SaleController {
  public create: RequestHandler = async (req: Request, res: Response): Promise<void> => {
    try {
      const result = await service.create(req.body as CreateSaleDataDto);
      res.status(201).json(result);
    } catch (error: any) {
      console.error(error);
      if (error.message && error.message.includes("não encontrado")) {
        res.status(400).json({ error: error.message });
        return;
      }
      if (error.code === "P2003") {
        res.status(400).json({
          error: "Erro de referência: Verifique se todos os IDs informados existem no banco de dados.",
        });
        return;
      }
      res.status(500).json({ error: "Failed to create sale" });
    }
  };

  public getAll: RequestHandler = async (_req: Request, res: Response): Promise<void> => {
    try {
      const result = await service.getAll();
      res.json(result);
    } catch (error: any) {
      console.error(error);
      res.status(500).json({ error: "Failed to fetch sales" });
    }
  };

  public getById: RequestHandler = async (req: Request, res: Response): Promise<void> => {
    try {
      const id = req.params.id;
      const result = await service.getById(id);
      if (!result) {
        res.status(404).json({ error: "Sale not found" });
        return;
      }

      const isAdmin = req.user?.role === "admin";
      const isBuyer = result.buyerId === req.user?.userId;
      const isSeller = result.boughtProducts.some(
        (bp: any) => bp.product?.sellerId === req.user?.userId
      );

      if (!isAdmin && !isBuyer && !isSeller) {
        res.status(403).json({ error: "Forbidden" });
        return;
      }

      res.json(result);
    } catch (error: any) {
      console.error(error);
      res.status(500).json({ error: "Failed to fetch sale" });
    }
  };

  public getSalesForProducer: RequestHandler = async (req, res) => {
    try {
      const userId = req.params.userId;
      if (!userId) {
        res.status(400).json({ error: "userId deve ser uma string (UUID) válida" });
        return;
      }

      if (req.user?.role !== "admin" && req.user?.userId !== userId) {
        res.status(403).json({ error: "Forbidden" });
        return;
      }

      const result = await service.getSalesForProducer(userId);
      res.json({
        message: "Vendas do producer obtidas com sucesso",
        totalSales: result.length,
        totalValue: result.reduce((sum, sale) => {
          const saleTotal = sale.boughtProducts.reduce((acc, p) => acc + p.value * p.amount, 0);
          return sum + saleTotal + sale.transportValue;
        }, 0),
        sales: result,
      });
    } catch (error: any) {
      console.error(error);
      if (error.message && (error.message.includes("não encontrado") || error.message.includes("não é um producer"))) {
        res.status(404).json({ error: error.message });
        return;
      }
      res.status(500).json({ error: "Failed to fetch producer sales" });
    }
  };

  public getPurchasesForBuyer: RequestHandler = async (req, res) => {
    try {
      const userId = req.params.userId;
      if (!userId) {
        res.status(400).json({ error: "userId deve ser uma string (UUID) válida" });
        return;
      }

      if (req.user?.role !== "admin" && req.user?.userId !== userId) {
        res.status(403).json({ error: "Forbidden" });
        return;
      }

      const result = await service.getPurchasesForBuyer(userId);
      res.json({
        message: "Compras do buyer obtidas com sucesso",
        totalPurchases: result.length,
        totalSpent: result.reduce((sum, purchase) => {
          const purchaseTotal = purchase.boughtProducts.reduce((acc, p) => acc + p.value * p.amount, 0);
          return sum + purchaseTotal + purchase.transportValue;
        }, 0),
        purchases: result,
      });
    } catch (error: any) {
      console.error(error);
      if (error.message && (error.message.includes("não encontrado") || error.message.includes("não é um buyer"))) {
        res.status(404).json({ error: error.message });
        return;
      }
      res.status(500).json({ error: "Failed to fetch buyer purchases" });
    }
  };

  public update: RequestHandler = async (req: Request, res: Response): Promise<void> => {
    try {
      const id = req.params.id;

      const access = await getSaleAccess(req, id);
      if (!access.found) {
        res.status(404).json({ error: "Sale not found" });
        return;
      }
      if (!access.role) {
        res.status(403).json({ error: "Forbidden" });
        return;
      }

      const sanitizedBody = sanitizeSaleUpdatePayload(access.role, req.body ?? {});
      const result = await service.update(id, sanitizedBody as UpdateSaleDataDto);
      res.json(result);
    } catch (error: any) {
      console.error(error);
      if (error.message === "SALE_STATUS_CONFLICT") {
        res.status(409).json({
          error: "O status do pedido foi alterado por outra requisição. Atualize a página e tente novamente.",
          code: "SALE_STATUS_CONFLICT",
        });
        return;
      }
      if (error.message?.startsWith("RESCHEDULE_BLOCKED_24H:")) {
        const field = error.message.split(":")[1];
        res.status(409).json({
          error: `Faltam menos de 24h para a operação de ${field}. Para reagendar, entre em contato com o suporte. Sujeito à multa de 10% conforme Cláusula 7.`,
          code: "RESCHEDULE_BLOCKED_24H",
        });
        return;
      }
      if (error.message?.startsWith("RESCHEDULE_EXCEEDS_MAX_DAYS:")) {
        const field = error.message.split(":")[1];
        res.status(409).json({
          error: `A nova data de ${field} excede o limite de 3 dias úteis da data original contratada (Cláusula 9).`,
          code: "RESCHEDULE_EXCEEDS_MAX_DAYS",
        });
        return;
      }
      res.status(500).json({ error: "Failed to update sale" });
    }
  };

  public delete: RequestHandler = async (req: Request, res: Response): Promise<void> => {
    try {
      const id = req.params.id;

      if (req.user?.role !== "admin") {
        res.status(403).json({ error: "Forbidden" });
        return;
      }

      await service.delete(id);
      res.status(204).send();
    } catch (error: any) {
      console.error(error);
      res.status(500).json({ error: "Failed to delete sale" });
    }
  };

  public calculateFreight: RequestHandler = async (req: Request, res: Response): Promise<void> => {
    const id = req.params.id;
    const { distanceKm, pricePerKm } = req.body;

    if (!id || typeof distanceKm !== "number" || typeof pricePerKm !== "number") {
      res.status(400).json({ message: "Parâmetros inválidos." });
      return;
    }

    try {
      const access = await getSaleAccess(req, id);
      if (!access.found) {
        res.status(404).json({ message: "Sale not found" });
        return;
      }
      if (access.role !== "admin") {
        res.status(403).json({ message: "Forbidden" });
        return;
      }

      const result = await service.calculateFreight(id, distanceKm, pricePerKm);
      res.status(200).json({ message: "Frete calculado com sucesso.", data: result });
    } catch (error: any) {
      console.error("Erro ao calcular o frete:", error);
      res.status(500).json({ message: error.message || "Erro interno." });
    }
  };

  public setSellerDecision: RequestHandler = async (req, res) => {
    try {
      const id = req.params.id;
      const { approved, plannedHarvestDate, plannedPickupDate, plannedDeliveryDate } = req.body;

      if (typeof approved !== "boolean") {
        res.status(400).json({ error: "Campo 'approved' deve ser boolean." });
        return;
      }

      const access = await getSaleAccess(req, id);
      if (!access.found) {
        res.status(404).json({ error: "Sale not found" });
        return;
      }
      if (access.role !== "admin" && access.role !== "seller") {
        res.status(403).json({ error: "Forbidden" });
        return;
      }

      const dto: SellerDecisionDto = {
        approved,
        plannedHarvestDate: plannedHarvestDate ? new Date(plannedHarvestDate) : undefined,
        plannedPickupDate: plannedPickupDate ? new Date(plannedPickupDate) : undefined,
        plannedDeliveryDate: plannedDeliveryDate ? new Date(plannedDeliveryDate) : undefined,
      };

      const result = await service.setSellerDecision(id, dto);
      res.status(200).json(result);
    } catch (error: any) {
      console.error(error);
      if (error.message === "SELLER_DECISION_CONFLICT") {
        res.status(409).json({
          error: "O status do pedido foi alterado por outra requisição. Atualize a página e tente novamente.",
          code: "SELLER_DECISION_CONFLICT",
        });
        return;
      }
      if (error.message === "PLANNED_HARVEST_DATE_REQUIRED") {
        res.status(400).json({ error: "plannedHarvestDate é obrigatório ao aprovar o pedido." });
        return;
      }
      if (error.message === "PLANNED_PICKUP_DATE_REQUIRED") {
        res.status(400).json({ error: "plannedPickupDate é obrigatório ao aprovar o pedido." });
        return;
      }
      res.status(500).json({ error: error.message || "Failed to set seller decision" });
    }
  };

  /** POST /sales/:id/documents — upload de documento operacional */
  public uploadDocument: RequestHandler = async (req, res) => {
    const VALID_DOC_TYPES = ['pesagem_tara', 'pesagem_bruto', 'nota_fiscal', 'canhoto_nf'] as const;

    try {
      const saleId = req.params.id;
      const uploadedById = req.user?.userId as string | undefined;
      if (!uploadedById) {
        res.status(401).json({ error: "Token inválido ou ausente." });
        return;
      }

      const { docType, fileUrl } = req.body;

      if (!docType || !fileUrl) {
        res.status(400).json({ error: "docType e fileUrl são obrigatórios." });
        return;
      }

      if (!VALID_DOC_TYPES.includes(docType)) {
        res.status(400).json({
          error: `docType inválido. Valores aceitos: ${VALID_DOC_TYPES.join(', ')}.`,
        });
        return;
      }

      const access = await getSaleAccess(req, saleId);
      if (!access.found) {
        res.status(404).json({ error: "Sale not found" });
        return;
      }
      if (!access.role) {
        res.status(403).json({ error: "Forbidden" });
        return;
      }

      const doc = await service.uploadOperationDocument({ saleId, uploadedById, docType, fileUrl });
      res.status(201).json(doc);
    } catch (error: any) {
      console.error(error);
      if (error.message?.includes("não encontrada")) {
        res.status(404).json({ error: error.message });
        return;
      }
      res.status(500).json({ error: "Erro ao registrar documento." });
    }
  };

  /** PATCH /sales/:id/authorize-harvest — autoriza colheita após confirmação da entrada */
  public authorizeHarvest: RequestHandler = async (req, res) => {
    try {
      const saleId = req.params.id;

      const access = await getSaleAccess(req, saleId);
      if (!access.found) {
        res.status(404).json({ error: "Venda não encontrada" });
        return;
      }
      if (!access.role) {
        res.status(403).json({ error: "Forbidden" });
        return;
      }

      const result = await service.authorizeHarvest(saleId);
      res.status(200).json(result);
    } catch (error: any) {
      if (error.message === 'HARVEST_BLOCKED_NO_DOWN_PAYMENT') {
        res.status(409).json({
          error: 'A colheita só pode ser autorizada após a confirmação do pagamento da entrada (30%).',
          code: 'HARVEST_BLOCKED_NO_DOWN_PAYMENT',
        });
        return;
      }
      if (error.message === 'SALE_STATUS_CONFLICT') {
        res.status(409).json({
          error: 'O status do pedido foi alterado por outra requisição. Atualize a página e tente novamente.',
          code: 'SALE_STATUS_CONFLICT',
        });
        return;
      }
      if (error.message === 'HARVEST_BLOCKED_SELLER_NOT_APPROVED') {
        res.status(409).json({
          error: 'A colheita só pode ser autorizada após o vendedor aprovar o pedido.',
          code: 'HARVEST_BLOCKED_SELLER_NOT_APPROVED',
        });
        return;
      }
      if (error.message?.includes('não encontrada')) {
        res.status(404).json({ error: error.message });
        return;
      }
      console.error(error);
      res.status(500).json({ error: 'Erro ao autorizar colheita.' });
    }
  };

  /** PATCH /sales/:id/payment-method — altera o método de pagamento da primeira parcela */
  public changePaymentMethod: RequestHandler = async (req, res) => {
    try {
      const saleId = req.params.id;
      const { paymentMethodId } = req.body;

      if (!paymentMethodId) {
        res.status(400).json({ error: 'paymentMethodId é obrigatório.' });
        return;
      }

      const access = await getSaleAccess(req, saleId);
      if (!access.found) {
        res.status(404).json({ error: 'Venda não encontrada' });
        return;
      }
      if (access.role !== 'admin' && access.role !== 'buyer') {
        res.status(403).json({ error: 'Forbidden' });
        return;
      }

      const result = await service.changePaymentMethod(saleId, paymentMethodId);
      res.status(200).json(result);
    } catch (error: any) {
      if (error.message === 'PAYMENT_ALREADY_COMPLETED') {
        res.status(409).json({
          error: 'Não é possível alterar o método de pagamento: o pagamento final já foi concluído.',
          code: 'PAYMENT_ALREADY_COMPLETED',
        });
        return;
      }
      if (error.message === 'DOWN_PAYMENT_ALREADY_COMPLETED') {
        res.status(409).json({
          error: 'Não é possível alterar o método de pagamento: a entrada já foi confirmada.',
          code: 'DOWN_PAYMENT_ALREADY_COMPLETED',
        });
        return;
      }
      if (error.message?.includes('não encontrad')) {
        res.status(404).json({ error: error.message });
        return;
      }
      console.error(error);
      res.status(500).json({ error: 'Erro ao alterar método de pagamento.' });
    }
  };

  /**
   * POST /sales/:id/weight — registra peso manual com upload do ticket de balança para o S3.
   * Espera multipart/form-data com campo 'file' (imagem/pdf) e 'weightKg' (número).
   */
  public registerWeight: RequestHandler = async (req, res) => {
    try {
      const saleId = req.params.id;
      const uploadedById = req.user?.userId as string | undefined;
      if (!uploadedById) {
        res.status(401).json({ error: 'Token inválido ou ausente.' });
        return;
      }

      const access = await getSaleAccess(req, saleId);
      if (!access.found) {
        res.status(404).json({ error: 'Venda não encontrada' });
        return;
      }
      if (access.role !== 'admin' && access.role !== 'seller') {
        res.status(403).json({ error: 'Forbidden' });
        return;
      }

      const file = req.file;
      if (!file) {
        res.status(400).json({ error: 'Arquivo do ticket de balança é obrigatório.' });
        return;
      }

      const weightKg = parseFloat(req.body.weightKg);
      if (isNaN(weightKg) || weightKg <= 0) {
        res.status(400).json({ error: 'weightKg deve ser um número maior que zero.' });
        return;
      }

      const uploaded = await s3Service.upload(file);

      const result = await service.registerManualWeight({
        saleId,
        uploadedById,
        weightKg,
        fileUrl: uploaded.publicUrl,
      });

      res.status(201).json({
        weightKg,
        fileUrl: uploaded.publicUrl,
        document: result.document,
        sale: result.sale,
      });
    } catch (error: any) {
      if (error.message === 'WEIGHT_ALREADY_REGISTERED') {
        res.status(409).json({
          error: 'O peso desta venda já foi registrado. Para corrigir, entre em contato com o suporte.',
          code: 'WEIGHT_ALREADY_REGISTERED',
        });
        return;
      }
      if (error.message === 'WEIGHT_BLOCKED_NO_DOWN_PAYMENT') {
        res.status(409).json({
          error: 'O peso só pode ser registrado após a confirmação do pagamento da entrada (30%).',
          code: 'WEIGHT_BLOCKED_NO_DOWN_PAYMENT',
        });
        return;
      }
      if (error.message === 'WEIGHT_BLOCKED_SELLER_NOT_APPROVED') {
        res.status(409).json({
          error: 'O peso só pode ser registrado após o vendedor aprovar o pedido.',
          code: 'WEIGHT_BLOCKED_SELLER_NOT_APPROVED',
        });
        return;
      }
      if (error.message?.includes('não encontrada')) {
        res.status(404).json({ error: error.message });
        return;
      }
      console.error(error);
      res.status(500).json({ error: 'Erro ao registrar peso.' });
    }
  };

  /** PATCH /sales/:id/apply-penalty — aplica multa por inadimplência e cancela a venda */
  public applyPenalty: RequestHandler = async (req, res) => {
    try {
      const saleId = req.params.id;
      const { penaltyAmount, reason } = req.body;

      if (req.user?.role !== 'admin') {
        res.status(403).json({ error: 'Forbidden' });
        return;
      }

      if (!reason || typeof reason !== 'string' || !reason.trim()) {
        res.status(400).json({ error: 'O campo reason (motivo da multa) é obrigatório.' });
        return;
      }

      if (penaltyAmount !== undefined && (typeof penaltyAmount !== 'number' || penaltyAmount < 0)) {
        res.status(400).json({ error: 'penaltyAmount deve ser um número maior ou igual a zero.' });
        return;
      }

      const result = await service.applyPenalty(saleId, { penaltyAmount, reason });
      res.status(200).json(result);
    } catch (error: any) {
      if (error.message === 'PENALTY_ALREADY_APPLIED') {
        res.status(409).json({ error: 'Multa já aplicada a esta venda.', code: 'PENALTY_ALREADY_APPLIED' });
        return;
      }
      if (error.message?.startsWith('PENALTY_BLOCKED:')) {
        res.status(409).json({ error: error.message.split(':')[1], code: 'PENALTY_BLOCKED' });
        return;
      }
      if (error.message?.includes('não encontrada')) {
        res.status(404).json({ error: error.message });
        return;
      }
      console.error(error);
      res.status(500).json({ error: 'Erro ao aplicar multa.' });
    }
  };

  /** POST /sales/:id/tacit-acceptance — aplica aceite tácito manualmente */
  public tacitAcceptance: RequestHandler = async (req, res) => {
    try {
      const saleId = req.params.id;

      const access = await getSaleAccess(req, saleId);
      if (!access.found) {
        res.status(404).json({ error: "Venda não encontrada" });
        return;
      }
      if (!access.role) {
        res.status(403).json({ error: "Forbidden" });
        return;
      }

      const result = await service.processTacitAcceptance(saleId);
      res.json(result);
    } catch (error: any) {
      console.error(error);
      if (error.message?.includes("não encontrada")) {
        res.status(404).json({ error: error.message });
        return;
      }
      res.status(500).json({ error: "Erro ao processar aceite tácito." });
    }
  };

  /** POST /sales/batch-tacit-acceptance — processa aceites tácitos em lote (cron) */
  public batchTacitAcceptance: RequestHandler = async (_req, res) => {
    try {
      const result = await service.processBatchTacitAcceptances();
      res.json(result);
    } catch (error: any) {
      console.error(error);
      res.status(500).json({ error: "Erro ao processar aceites tácitos em lote." });
    }
  };
}
