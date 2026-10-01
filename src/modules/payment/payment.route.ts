import express, { RequestHandler } from 'express';
import { protectRoute, requireAdmin } from '../../middlewares/auth.middleware';
import { PaymentController } from './payment.controller';

const router = express.Router();
const controller = new PaymentController();

/**
 * @swagger
 * /payment/webhook:
 *   post:
 *     summary: Endpoint para processar webhooks do Mercado Pago
 *     description: Recebe notificações do Mercado Pago sobre mudanças no status dos pagamentos (Payment API e Orders API)
 *     tags: [PaymentMethods]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               type:
 *                 type: string
 *                 example: "payment"
 *               topic:
 *                 type: string
 *                 example: "order"
 *               action:
 *                 type: string
 *                 example: "payment.updated"
 *               data:
 *                 type: object
 *                 properties:
 *                   id:
 *                     type: string
 *                     example: "ORD01HRYFWNYRE1MR1E60MW3X0T2P"
 *     responses:
 *       200:
 *         description: Webhook processado com sucesso
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 paymentId:
 *                   type: string
 *                 status:
 *                   type: string
 *       500:
 *         description: Erro ao processar webhook
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   example: "Erro ao processar webhook."
 *                 message:
 *                   type: string
 */
router.post('/webhook', controller.processWebhook as RequestHandler);

router.use(protectRoute);

// ─── Rotas sem parâmetro dinâmico (devem vir ANTES de /:id) ──────────────────

/**
 * @swagger
 * /payment/preference:
 *   post:
 *     summary: Cria uma preferência de pagamento Mercado Pago (Checkout Pro)
 *     description: Cria uma preferência de pagamento no Mercado Pago e registra o pagamento vinculado a uma venda
 *     tags: [PaymentMethods]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - saleId
 *               - paymentMethodId
 *               - productId
 *               - title
 *               - unit_price
 *               - quantity
 *               - amount
 *             properties:
 *               saleId:
 *                 type: string
 *                 description: ID da venda no sistema
 *                 example: "clx456ghi789"
 *               paymentMethodId:
 *                 type: string
 *                 description: ID do método de pagamento
 *                 example: "clx123abc456"
 *               productId:
 *                 type: string
 *                 description: ID do produto
 *                 example: "clx999xyz123"
 *               title:
 *                 type: string
 *                 description: Título do produto/serviço
 *                 example: "Fertilizante NPK 10-10-10 - 50kg"
 *               unit_price:
 *                 type: number
 *                 description: Preço unitário do produto
 *                 example: 250.50
 *               quantity:
 *                 type: integer
 *                 description: Quantidade de itens
 *                 example: 2
 *               amount:
 *                 type: number
 *                 description: Valor total do pagamento
 *                 example: 501.00
 *               phase:
 *                 type: string
 *                 enum: [down_payment, final_payment, full]
 *                 description: "Fase do pagamento — down_payment: entrada 30% (recalculada server-side), final_payment: segunda parcela, full: pagamento único"
 *                 default: full
 *     responses:
 *       201:
 *         description: Preferência criada com sucesso
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 paymentId:
 *                   type: string
 *                   description: ID do pagamento criado no sistema
 *                   example: "clx789def012"
 *                 mp_preference_id:
 *                   type: string
 *                   description: ID da preferência no Mercado Pago
 *                   example: "123456789-abc-def"
 *                 init_point:
 *                   type: string
 *                   description: URL para redirecionar o usuário ao checkout
 *                   example: "https://www.mercadopago.com.br/checkout/v1/redirect?pref_id=123456789"
 *       400:
 *         description: Dados obrigatórios não fornecidos
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   example: "Dados obrigatórios não fornecidos."
 *       500:
 *         description: Erro ao criar preferência de pagamento
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   example: "Erro ao criar preferência de pagamento."
 *                 message:
 *                   type: string
 *                   example: "At least one policy returned UNAUTHORIZED."
 */
router.post('/preference', controller.createPreference as RequestHandler);
router.get('/methods', controller.getPaymentMethods as RequestHandler);
router.post('/pix', controller.createPixPayment as RequestHandler);
/**
 * @swagger
 * /payment/boleto:
 *   post:
 *     summary: Cria um boleto bancário usando Orders API (Checkout Transparente)
 *     description: >
 *       Cria um boleto bancário vinculado a uma venda. Use `phase` para indicar se é a entrada (30%)
 *       ou a segunda parcela (70%). Para a segunda parcela, prefira `POST /payment/final-boleto`
 *       que valida automaticamente se a entrada já foi confirmada.
 *     tags: [PaymentMethods]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [saleId, paymentMethodId, amount]
 *             properties:
 *               saleId:
 *                 type: string
 *                 description: ID da venda
 *               paymentMethodId:
 *                 type: string
 *                 description: ID do método de pagamento (boleto)
 *               amount:
 *                 type: number
 *                 description: Valor do boleto em reais
 *                 example: 150.00
 *               expirationDays:
 *                 type: number
 *                 description: Dias para vencimento (padrão 3)
 *                 example: 3
 *               phase:
 *                 type: string
 *                 enum: [down_payment, final_payment, full]
 *                 description: "Fase do pagamento — down_payment: entrada 30%, final_payment: segunda parcela 70%, full: pagamento único"
 *                 default: full
 *     responses:
 *       201:
 *         description: Boleto criado com sucesso
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 paymentId:
 *                   type: string
 *                   description: ID do pagamento no banco local
 *                 orderId:
 *                   type: string
 *                   description: ID da Order no Mercado Pago
 *                 orderStatus:
 *                   type: string
 *                   example: pending
 *                 payment:
 *                   type: object
 *                   properties:
 *                     id:
 *                       type: string
 *                     status:
 *                       type: string
 *                       example: pending
 *                     barcode:
 *                       type: string
 *                       description: Código de barras do boleto
 *                     boleto_url:
 *                       type: string
 *                       description: URL para visualizar/imprimir o boleto
 *                     expiration_date:
 *                       type: string
 *                       format: date-time
 *       400:
 *         description: Dados obrigatórios ausentes ou valor inválido
 *       500:
 *         description: Erro ao criar boleto
 */
router.post('/boleto', controller.createBoletoPayment as RequestHandler);
router.post('/card', controller.createCreditCardPayment as RequestHandler);
router.post('/final-boleto', controller.createFinalBoleto as RequestHandler);
router.post('/configure-webhook', requireAdmin as RequestHandler, controller.configureWebhook as RequestHandler);

/**
 * @swagger
 * /payment/sync-pending:
 *   post:
 *     summary: Sincroniza todos os pagamentos pendentes via Orders API
 *     description: >
 *       Consulta o status de todos os pagamentos com `status=pending` e `mp_order_id` preenchido
 *       diretamente na Mercado Pago Orders API. Confirma automaticamente os que já foram pagos.
 *       Esse endpoint é chamado a cada 5 minutos pelo poller interno do servidor, mas pode ser
 *       acionado manualmente para forçar sincronização imediata (útil após pagamento de boleto).
 *     tags: [PaymentMethods]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Sincronização concluída
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 checked:
 *                   type: integer
 *                   description: Total de pagamentos pendentes verificados
 *                   example: 3
 *                 confirmed:
 *                   type: integer
 *                   description: Pagamentos confirmados neste ciclo
 *                   example: 1
 *                 errors:
 *                   type: integer
 *                   description: Erros ao consultar a API do Mercado Pago
 *                   example: 0
 *       500:
 *         description: Erro ao executar sincronização
 */
router.post('/sync-pending', requireAdmin as RequestHandler, controller.syncPendingOrderPayments as RequestHandler);

// Calcula o valor da segunda parcela — duas formas de URL para compatibilidade com o frontend
router.get('/sales/:saleId/final-amount', controller.getFinalInstallmentAmount as RequestHandler);
router.get('/final-amount/:saleId', controller.getFinalInstallmentAmount as RequestHandler);

// ─── Rotas com parâmetro dinâmico (:id) — SEMPRE no final ────────────────────

/**
 * @swagger
 * /payment/{id}:
 *   get:
 *     summary: Busca um pagamento específico por ID
 *     tags: [PaymentMethods]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: ID do pagamento
 *         example: "clx789def012"
 *     responses:
 *       200:
 *         description: Pagamento encontrado
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Payment'
 *       400:
 *         description: ID inválido
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   example: "ID inválido."
 *       404:
 *         description: Pagamento não encontrado
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   example: "Pagamento não encontrado."
 *       500:
 *         description: Erro ao buscar pagamento
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   example: "Erro ao buscar pagamento."
 *                 message:
 *                   type: string
 */
router.get('/:id', controller.getById as RequestHandler);
router.post('/:id/sync', controller.syncPaymentStatus as RequestHandler);
router.get('/:id/debug', controller.debugPayment as RequestHandler);
router.patch('/:id', controller.updatePayment as RequestHandler);
router.post('/:id/cancel', controller.cancelPixPayment as RequestHandler);

/**
 * @swagger
 * /payment/{id}/sync:
 *   post:
 *     summary: Sincroniza o status de um pagamento com o Mercado Pago
 *     description: Busca o status atual do pagamento no Mercado Pago e atualiza no banco de dados. Útil quando o webhook não chega ou para verificação manual.
 *     tags: [PaymentMethods]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: ID do pagamento no sistema
 *         example: "d307cd23-bf88-4b0d-bd33-3c93ef5f8ba6"
 *     responses:
 *       200:
 *         description: Status sincronizado com sucesso
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 updated:
 *                   type: boolean
 *                   example: true
 *                 payment:
 *                   type: object
 *                   properties:
 *                     id:
 *                       type: string
 *                       example: "d307cd23-bf88-4b0d-bd33-3c93ef5f8ba6"
 *                     status:
 *                       type: string
 *                       example: "completed"
 *                     mp_payment_id:
 *                       type: string
 *                       example: "1234567890"
 *                     mp_status:
 *                       type: string
 *                       example: "approved"
 *                 mercadopago:
 *                   type: object
 *                   properties:
 *                     id:
 *                       type: string
 *                       example: "1234567890"
 *                     status:
 *                       type: string
 *                       example: "approved"
 *                     transaction_amount:
 *                       type: number
 *                       example: 100.00
 *                     date_approved:
 *                       type: string
 *                       format: date-time
 *       404:
 *         description: Pagamento não encontrado ou não processado ainda
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: false
 *                 message:
 *                   type: string
 *                   example: "Pagamento ainda não foi realizado ou processado pelo Mercado Pago"
 *       400:
 *         description: ID inválido
 *       500:
 *         description: Erro ao sincronizar status
 */
/**
 * @swagger
 * /payment/{id}/debug:
 *   get:
 *     summary: Debug de um pagamento - informações detalhadas
 *     description: Retorna informações completas do pagamento tanto no banco quanto no Mercado Pago para debug
 *     tags: [PaymentMethods]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: ID do pagamento no sistema
 *         example: "d307cd23-bf88-4b0d-bd33-3c93ef5f8ba6"
 *     responses:
 *       200:
 *         description: Informações de debug retornadas
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 paymentRecord:
 *                   type: object
 *                   description: Dados do pagamento no banco
 *                 mpData:
 *                   type: object
 *                   description: Dados do pagamento no Mercado Pago
 *                 canSync:
 *                   type: boolean
 *                   description: Se é possível sincronizar o pagamento
 *       400:
 *         description: ID inválido
 *       500:
 *         description: Erro ao buscar informações de debug
 */
/**
 * @swagger
 * /payment/{id}:
 *   patch:
 *     summary: Atualiza informações de um pagamento
 *     description: Atualiza dados como status, mp_payment_id, etc.
 *     tags: [PaymentMethods]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: ID do pagamento
 *         example: "clx789def012"
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               status:
 *                 type: string
 *                 enum: [pending, approved, rejected, cancelled]
 *                 example: "approved"
 *               mp_payment_id:
 *                 type: string
 *                 example: "987654321"
 *               amount:
 *                 type: number
 *                 example: 250.50
 *     responses:
 *       200:
 *         description: Pagamento atualizado com sucesso
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Payment'
 *       400:
 *         description: ID inválido
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   example: "ID inválido."
 *       500:
 *         description: Erro ao atualizar pagamento
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   example: "Erro ao atualizar pagamento."
 *                 message:
 *                   type: string
 */
/**
 * @swagger
 * /payment/methods:
 *   get:
 *     summary: Lista todos os meios de pagamento disponíveis
 *     description: Retorna todos os métodos de pagamento aceitos pelo Mercado Pago
 *     tags: [PaymentMethods]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Lista de meios de pagamento retornada com sucesso
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 type: object
 *                 properties:
 *                   id:
 *                     type: string
 *                     example: "pix"
 *                   name:
 *                     type: string
 *                     example: "PIX"
 *                   payment_type_id:
 *                     type: string
 *                     example: "bank_transfer"
 *                   status:
 *                     type: string
 *                     example: "active"
 *       500:
 *         description: Erro ao buscar meios de pagamento
 */
/**
 * @swagger
 * /payment/pix:
 *   post:
 *     summary: Cria um pagamento PIX usando Orders API (Checkout Transparente)
 *     description: Cria um pagamento PIX instantâneo retornando QR Code e Pix Copia e Cola
 *     tags: [PaymentMethods]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - saleId
 *               - paymentMethodId
 *               - amount
 *               - email
 *             properties:
 *               saleId:
 *                 type: string
 *                 description: ID da venda no sistema
 *                 example: "sale-123-abc-456"
 *               paymentMethodId:
 *                 type: string
 *                 description: ID do método de pagamento (PIX)
 *                 example: "pm-pix-001"
 *               amount:
 *                 type: number
 *                 description: Valor do pagamento
 *                 example: 150.50
 *               email:
 *                 type: string
 *                 format: email
 *                 description: Email do pagador
 *                 example: "cliente@example.com"
 *               expirationMinutes:
 *                 type: number
 *                 description: Tempo de expiração em minutos (30 a 43200 - 30 dias)
 *                 example: 60
 *                 default: 30
 *               phase:
 *                 type: string
 *                 enum: [down_payment, final_payment, full]
 *                 description: "Fase do pagamento — down_payment: entrada 30%, final_payment: segunda parcela, full: pagamento único"
 *                 default: full
 *     responses:
 *       201:
 *         description: Pagamento PIX criado com sucesso
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 paymentId:
 *                   type: string
 *                   description: ID do pagamento no banco local
 *                   example: "pay-uuid-123-456"
 *                 orderId:
 *                   type: string
 *                   description: ID da Order no Mercado Pago
 *                   example: "ORD01HRYFWNYRE1MR1E60MW3X0T2P"
 *                 orderStatus:
 *                   type: string
 *                   example: "action_required"
 *                 payment:
 *                   type: object
 *                   properties:
 *                     id:
 *                       type: string
 *                       example: "PAY01HRYFXQ53Q3JPEC48MYWMR0TE"
 *                     status:
 *                       type: string
 *                       example: "action_required"
 *                     status_detail:
 *                       type: string
 *                       example: "waiting_transfer"
 *                     qr_code:
 *                       type: string
 *                       description: Código PIX Copia e Cola
 *                       example: "00020126580014br.gov.bcb.pix..."
 *                     qr_code_base64:
 *                       type: string
 *                       description: Imagem QR Code em Base64
 *                       example: "iVBORw0KGgoAAAANSUhEUgAABWQAAAVk..."
 *                     ticket_url:
 *                       type: string
 *                       description: URL da página de pagamento
 *                       example: "https://www.mercadopago.com.br/sandbox/payments/..."
 *       400:
 *         description: Dados obrigatórios não fornecidos ou inválidos
 *       500:
 *         description: Erro ao criar pagamento PIX
 */
/**
 * @swagger
 * /payment/final-boleto:
 *   post:
 *     summary: Cria o boleto da segunda parcela (70%) — sempre boleto por regra de negócio
 *     description: >
 *       Requer que a entrada de 30% já esteja confirmada (downPaymentCompleted=true).
 *       O `amount` pode ser informado explicitamente para ajustar pelo peso real da carga.
 *       Se omitido, calcula automaticamente como (total do contrato - entrada paga).
 *     tags: [PaymentMethods]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [saleId, paymentMethodId]
 *             properties:
 *               saleId:
 *                 type: string
 *               paymentMethodId:
 *                 type: string
 *               amount:
 *                 type: number
 *                 description: Valor ajustado da parcela final (opcional — usa cálculo automático se omitido)
 *               expirationDays:
 *                 type: number
 *                 description: Dias para vencimento do boleto (padrão 3)
 *     responses:
 *       201: { description: Boleto final criado com sucesso }
 *       409: { description: Entrada ainda não confirmada ou boleto já existe }
 */
/**
 * @swagger
 * /payment/sales/{saleId}/final-amount:
 *   get:
 *     summary: Calcula o valor da segunda parcela (70%) para uma venda
 *     description: >
 *       Retorna contractTotal, totalDownPaid e finalAmount considerando o peso real
 *       quando registrado (adjustedContractTotal). Disponível também como
 *       `GET /payment/final-amount/{saleId}` (alias de compatibilidade).
 *     tags: [PaymentMethods]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: saleId
 *         required: true
 *         schema: { type: string }
 *         description: ID da venda
 *     responses:
 *       200:
 *         description: Valores calculados com sucesso
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 contractTotal:
 *                   type: number
 *                   description: Valor total do contrato (ajustado pelo peso se disponível)
 *                 totalDownPaid:
 *                   type: number
 *                   description: Total já pago na entrada
 *                 finalAmount:
 *                   type: number
 *                   description: Valor restante a pagar (contractTotal - totalDownPaid)
 *                 weightAdjusted:
 *                   type: boolean
 *                   description: Indica se o valor foi recalculado com base no peso real
 *       409: { description: Entrada ainda não confirmada }
 *       404: { description: Venda não encontrada }
 */
/**
 * @swagger
 * /payment/final-amount/{saleId}:
 *   get:
 *     summary: "[Alias] Calcula o valor da segunda parcela (70%)"
 *     description: Alias de `/payment/sales/{saleId}/final-amount` para compatibilidade com o frontend.
 *     tags: [PaymentMethods]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: saleId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: Valores calculados }
 *       409: { description: Entrada ainda não confirmada }
 */
/**
 * @swagger
 * /payment/{id}/cancel:
 *   post:
 *     summary: Cancela um pagamento PIX pendente
 *     description: Cancela um pagamento PIX que ainda não foi pago (status pending)
 *     tags: [PaymentMethods]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: ID do pagamento
 *         example: "pay-uuid-123-456"
 *     responses:
 *       200:
 *         description: Pagamento cancelado com sucesso
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 paymentId:
 *                   type: string
 *                   example: "pay-uuid-123-456"
 *                 status:
 *                   type: string
 *                   example: "cancelled"
 *       400:
 *         description: Pagamento não pode ser cancelado (não está pendente)
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: false
 *                 error:
 *                   type: string
 *                   example: "Pagamento não pode ser cancelado. Status atual: completed"
 *       500:
 *         description: Erro ao cancelar pagamento
 */
/**
 * @swagger
 * /payment/configure-webhook:
 *   post:
 *     summary: Configura webhook do Mercado Pago
 *     description: Registra a URL de webhook no Mercado Pago para receber notificações de pagamentos
 *     tags: [PaymentMethods]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Webhook configurado com sucesso
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 id:
 *                   type: string
 *                   example: "webhook-id-123"
 *                 url:
 *                   type: string
 *                   example: "https://api.vendamaisagro.com.br/payment-methods/webhook"
 *                 events:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       topic:
 *                         type: string
 *                         example: "payment"
 *       500:
 *         description: Erro ao configurar webhook
 */
export default router;