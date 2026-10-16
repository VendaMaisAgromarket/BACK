import express from "express";
import { SaleController } from "./sales.controller";
import { protectRoute, requireAdmin } from "../../middlewares/auth.middleware";
import { requireAddress } from "../../middlewares/requireAddress.middleware";
import { uploadMemory } from "../../middlewares/upload";
import { RequestHandler } from "express";

const router = express.Router();
const controller = new SaleController();
router.use(protectRoute as RequestHandler);

/**
 * @swagger
 * components:
 *   schemas:
 *     BoughtProduct:
 *       type: object
 *       required: [productId, sellingUnitProductId, value, amount]
 *       properties:
 *         productId:
 *           type: string
 *           format: uuid
 *           example: "d2a4c3f8-1b2c-4d5e-8f90-1234567890ab"
 *         sellingUnitProductId:
 *           type: string
 *           format: uuid
 *           example: "f1e2d3c4-b5a6-7c8d-9e0f-112233445566"
 *         value:
 *           type: number
 *           example: 50.0
 *         amount:
 *           type: integer
 *           example: 2
 *
 *     SaleData:
 *       type: object
 *       required: [transportTypeId, transportValue, addressId, paymentMethodId, buyerId, boughtProducts]
 *       properties:
 *         id:
 *           type: string
 *           format: uuid
 *           example: "a1b2c3d4-e5f6-7890-abcd-ef0123456789"
 *         transportTypeId:
 *           type: string
 *           format: uuid
 *         createdAt:
 *           type: string
 *           format: date-time
 *           example: "2025-10-10T16:35:16.684Z"
 *         shippedAt:
 *           type: string
 *           format: date-time
 *           nullable: true
 *         arrivedAt:
 *           type: string
 *           format: date-time
 *           nullable: true
 *         transportValue:
 *           type: number
 *           example: 15.5
 *         cargoWeightKg:
 *           description: Peso total da carga em KG (informado pelo vendedor). No request envia-se número; no response pode vir string (Decimal).
 *           oneOf:
 *             - type: number
 *               example: 125.5
 *             - type: string
 *               example: "125.50"
 *         productRating:
 *           type: number
 *           example: 0
 *         sellerRating:
 *           type: number
 *           example: 0
 *         sellerApproved:
 *           type: boolean
 *           nullable: true
 *           description: "Decisão do vendedor: true=aceito, false=recusado, null=pendente"
 *           example: null
 *         addressId:
 *           type: string
 *           format: uuid
 *         paymentMethodId:
 *           type: string
 *           format: uuid
 *         buyerId:
 *           type: string
 *           format: uuid
 *         paymentCompleted:
 *           type: boolean
 *           description: true quando o pagamento final (70%) foi confirmado pelo Mercado Pago
 *           example: false
 *         downPaymentCompleted:
 *           type: boolean
 *           description: true quando a entrada (30%) foi confirmada pelo Mercado Pago
 *           example: false
 *         firstInstallmentPaid:
 *           type: boolean
 *           description: "[Computed] true se a entrada foi paga (downPaymentCompleted ou payment com phase=down_payment e status=completed)"
 *           readOnly: true
 *           example: false
 *         finalPaymentPaid:
 *           type: boolean
 *           description: "[Computed] true se o pagamento final foi pago (paymentCompleted ou payment com phase=final_payment/full e status=completed)"
 *           readOnly: true
 *           example: false
 *         adjustedContractTotal:
 *           type: number
 *           nullable: true
 *           description: Valor total ajustado após pesagem real (inclui frete). Null se peso não foi registrado.
 *           example: 9234.50
 *         penaltyApplied:
 *           type: boolean
 *           description: true se multa por inadimplência foi aplicada
 *           example: false
 *         penaltyAmount:
 *           type: number
 *           nullable: true
 *           description: Valor da multa em reais
 *           example: 150.00
 *         penaltyReason:
 *           type: string
 *           nullable: true
 *           description: Motivo da multa
 *           example: "Atraso no pagamento da segunda parcela"
 *         status:
 *           type: string
 *           description: >
 *             Status atual da venda. Sequência do fluxo: "Pedido realizado!" →
 *             "Aprovado pelo vendedor" | "Recusado pelo vendedor" → "Entrada confirmada" →
 *             "Colheita autorizada" → "Aguardando pagamento final" → "Concluído".
 *             Outros valores: "Em processamento", "Disponível para entrega", "Entregue", "Cancelado".
 *             O status "Concluído" é atribuído tanto pela confirmação do pagamento final (webhook/polling)
 *             quanto pelo aceite tácito de entrega (Cláusula 5).
 *           example: "Pedido realizado!"
 *         boughtProducts:
 *           type: array
 *           items:
 *             $ref: '#/components/schemas/BoughtProduct'
 */
router.post("/", requireAddress as RequestHandler, controller.create as RequestHandler);

/**
 * @swagger
 * /sales:
 *   post:
 *     summary: Cria uma nova venda
 *     tags: [Sales]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/SaleData'
 *           examples:
 *             basico:
 *               summary: Venda simples com peso de carga
 *               value:
 *                 transportTypeId: "11111111-2222-3333-4444-555555555555"
 *                 createdAt: "2025-10-10T16:35:16.684Z"
 *                 transportValue: 15.5
 *                 cargoWeightKg: 125.5
 *                 addressId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
 *                 paymentMethodId: "99999999-8888-7777-6666-555555555555"
 *                 buyerId: "12121212-3434-5656-7878-909090909090"
 *                 boughtProducts:
 *                   - productId: "aaaaaaaa-bbbb-cccc-dddd-000000000001"
 *                     sellingUnitProductId: "aaaaaaaa-bbbb-cccc-dddd-000000000002"
 *                     value: 50
 *                     amount: 2
 *     responses:
 *       201:
 *         description: Venda criada com sucesso
 */
router.get("/", requireAdmin as RequestHandler, controller.getAll as RequestHandler);

/**
 * @swagger
 * /sales/{id}:
 *   get:
 *     summary: Busca venda por ID
 *     tags: [Sales]
 *     parameters:
 *       - in: path
 *         name: id
 *         schema: { type: string, format: uuid }
 *         required: true
 *         description: ID da venda
 *     responses:
 *       200:
 *         description: Venda encontrada
 */
router.get("/:id", controller.getById as RequestHandler);

/**
 * @swagger
 * /sales/{id}:
 *   put:
 *     summary: Atualiza uma venda
 *     tags: [Sales]
 *     parameters:
 *       - in: path
 *         name: id
 *         schema: { type: string, format: uuid }
 *         required: true
 *         description: ID da venda
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/SaleData'
 *           examples:
 *             atualizarPeso:
 *               summary: Atualizar apenas o peso da carga (KG)
 *               value:
 *                 cargoWeightKg: 140.25
 *     responses:
 *       200:
 *         description: Venda atualizada
 */
router.put("/:id", controller.update as RequestHandler);

/**
 * @swagger
 * /sales/{id}:
 *   delete:
 *     summary: Remove uma venda
 *     tags: [Sales]
 *     parameters:
 *       - in: path
 *         name: id
 *         schema: { type: string, format: uuid }
 *         required: true
 *         description: ID da venda
 *     responses:
 *       204:
 *         description: Venda removida
 */
router.delete("/:id", controller.delete as RequestHandler);

/**
 * @swagger
 * /sales/{id}/calculate-freight:
 *   patch:
 *     summary: Calcula o valor do frete com base em distância e valor por km
 *     tags: [Sales]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *         description: ID da venda (saleDataId)
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [distanceKm, pricePerKm]
 *             properties:
 *               distanceKm: { type: number, example: 150 }
 *               pricePerKm: { type: number, example: 1.5 }
 *     responses:
 *       200:
 *         description: Frete calculado com sucesso
 */
router.patch("/:id/calculate-freight", controller.calculateFreight as unknown as RequestHandler);

router.get("/producer/:userId", controller.getSalesForProducer);
router.get("/buyer/:userId", controller.getPurchasesForBuyer);

/**
 * @swagger
 * /sales/{id}/seller-decision:
 *   patch:
 *     summary: Decisão do vendedor (aceitar ou recusar o pedido). Ao aceitar, preenche as datas do contrato.
 *     tags: [Sales]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [approved]
 *             properties:
 *               approved:
 *                 type: boolean
 *               plannedHarvestDate:
 *                 type: string
 *                 format: date-time
 *                 description: Opcional — pode ser preenchido via PATCH /sales/:id posteriormente
 *               plannedPickupDate:
 *                 type: string
 *                 format: date-time
 *                 description: Opcional — pode ser preenchido via PATCH /sales/:id posteriormente
 *               plannedDeliveryDate:
 *                 type: string
 *                 format: date-time
 *                 description: Opcional — pode ser preenchido via PATCH /sales/:id posteriormente
 *     responses:
 *       200: { description: Decisão registrada }
 *       400: { description: Payload inválido }
 *       404: { description: Venda não encontrada }
 *       409: { description: "SELLER_DECISION_CONFLICT — o status mudou por outra requisição simultânea; recarregar a venda e tentar de novo" }
 */
router.patch("/:id/seller-decision", controller.setSellerDecision as RequestHandler);

/**
 * @swagger
 * /sales/{id}/documents:
 *   post:
 *     summary: Registra documento operacional (pesagem, NF, canhoto). Upload de canhoto_nf registra entrega efetiva.
 *     tags: [Sales]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [uploadedById, docType, fileUrl]
 *             properties:
 *               uploadedById:
 *                 type: string
 *                 format: uuid
 *               docType:
 *                 type: string
 *                 enum: [pesagem_tara, pesagem_bruto, nota_fiscal, canhoto_nf]
 *                 description: canhoto_nf preenche automaticamente a data de entrega efetiva (Cláusula 5)
 *               fileUrl:
 *                 type: string
 *     responses:
 *       201: { description: Documento registrado }
 *       400: { description: Parâmetros inválidos }
 *       404: { description: Venda não encontrada }
 */
router.post("/:id/documents", controller.uploadDocument as RequestHandler);

/**
 * @swagger
 * /sales/{id}/tacit-acceptance:
 *   post:
 *     summary: Aplica aceite tácito para a venda (Cláusula 5 – plannedDeliveryDate + 1 dia útil vencido)
 *     tags: [Sales]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200: { description: Resultado do processamento }
 *       404: { description: Venda não encontrada }
 */
router.post("/:id/tacit-acceptance", controller.tacitAcceptance as RequestHandler);

/**
 * @swagger
 * /sales/batch-tacit-acceptance:
 *   post:
 *     summary: Processa aceites tácitos em lote para todas as vendas elegíveis (uso por cron job)
 *     tags: [Sales]
 *     responses:
 *       200: { description: Resultado do processamento em lote }
 */
router.post("/batch-tacit-acceptance", requireAdmin as RequestHandler, controller.batchTacitAcceptance as RequestHandler);

/**
 * @swagger
 * /sales/{id}/authorize-harvest:
 *   patch:
 *     summary: Autoriza a colheita de uma venda após confirmação da entrada (30%)
 *     description: Bloqueado se downPaymentCompleted=false ou se o vendedor ainda não aprovou o pedido.
 *     tags: [Sales]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200: { description: Colheita autorizada }
 *       409: { description: Entrada não confirmada ou vendedor não aprovou }
 */
router.patch("/:id/authorize-harvest", controller.authorizeHarvest as RequestHandler);

/**
 * @swagger
 * /sales/{id}/payment-method:
 *   patch:
 *     summary: Altera o método de pagamento da primeira parcela (entrada 30%)
 *     description: Cancela pagamentos pendentes e atualiza o método. Bloqueado após a entrada ser confirmada.
 *     tags: [Sales]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [paymentMethodId]
 *             properties:
 *               paymentMethodId:
 *                 type: string
 *                 format: uuid
 *     responses:
 *       200: { description: Método de pagamento atualizado }
 *       409: { description: Entrada ou pagamento final já confirmado }
 */
router.patch("/:id/payment-method", controller.changePaymentMethod as RequestHandler);

/**
 * @swagger
 * /sales/{id}/weight:
 *   post:
 *     summary: Registra o peso real da carga com upload do ticket de balança para o S3
 *     description: >
 *       Operação atômica: cria OperationDocument (ticket_balanca) e atualiza cargoWeightKg + weightDocumentId na venda.
 *       Aceita multipart/form-data com campo 'file' (imagem ou PDF) e 'weightKg' (número).
 *       Bloqueado se já houver um peso registrado — para corrigir contate o suporte.
 *     tags: [Sales]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             required: [file, weightKg]
 *             properties:
 *               file:
 *                 type: string
 *                 format: binary
 *                 description: Foto ou PDF do ticket de balança
 *               weightKg:
 *                 type: number
 *                 description: Peso real da carga em kg
 *                 example: 9500.5
 *     responses:
 *       201: { description: Peso registrado e documento salvo no S3 }
 *       409: { description: Peso já registrado ou vendedor não aprovou }
 *       400: { description: Arquivo ou weightKg ausente/inválido }
 */
router.post("/:id/weight", uploadMemory.single("file"), controller.registerWeight as RequestHandler);

/**
 * @swagger
 * /sales/{id}/apply-penalty:
 *   patch:
 *     summary: Aplica multa por inadimplência e cancela a venda
 *     description: >
 *       Define penaltyApplied=true, penaltyAmount e penaltyReason na venda e altera o status para "Cancelado".
 *       Bloqueado se o pagamento final já foi confirmado ou se multa já foi aplicada.
 *     tags: [Sales]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [reason]
 *             properties:
 *               reason:
 *                 type: string
 *                 description: Motivo da multa
 *               penaltyAmount:
 *                 type: number
 *                 description: Valor da multa em reais (opcional)
 *                 example: 150.00
 *     responses:
 *       200: { description: Multa aplicada e venda cancelada }
 *       400: { description: reason ausente ou penaltyAmount inválido }
 *       409: { description: Multa já aplicada ou pagamento final já confirmado }
 *       404: { description: Venda não encontrada }
 */
router.patch("/:id/apply-penalty", controller.applyPenalty as RequestHandler);

export default router;
