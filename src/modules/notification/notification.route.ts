import { Router, Request, Response, NextFunction, RequestHandler } from "express";
import { NotificationController } from "./notification.controller";
import { protectRoute } from "../../middlewares/auth.middleware";

const router = Router();
const controller = new NotificationController();

const wrap =
  (fn: (req: Request, res: Response) => Promise<unknown> | void) =>
    (req: Request, res: Response, next: NextFunction) =>
      Promise.resolve(fn(req, res)).catch(next);

router.use(protectRoute as RequestHandler);

/**
 * @swagger
 * tags:
 *   - name: Notifications
 *     description: Notificações in-app do usuário autenticado
 */

/**
 * @swagger
 * components:
 *   schemas:
 *     Notification:
 *       type: object
 *       properties:
 *         id: { type: string, format: uuid }
 *         type:
 *           type: string
 *           enum: [NEW_ORDER, ORDER_ACCEPTED, ORDER_REJECTED, DOWN_PAYMENT_RECEIVED, WEIGHT_REGISTERED, FINAL_PAYMENT_RECEIVED, ORDER_STATUS_CHANGED, PRODUCT_HARVEST_REMINDER]
 *         title: { type: string, example: "Novo pedido recebido" }
 *         message: { type: string, example: "Você recebeu o pedido #123 de Fulano. Acesse para aceitar ou recusar." }
 *         saleId: { type: string, format: uuid, nullable: true }
 *         productId: { type: string, format: uuid, nullable: true, description: Preenchido em PRODUCT_HARVEST_REMINDER }
 *         data:
 *           type: object
 *           nullable: true
 *           description: Sempre traz `role` (buyer|seller); `orderNumber` nas notificações de venda; demais campos variam por tipo (status, amount, phase, weightKg, harvestAt, daysLeft...).
 *         readAt: { type: string, format: date-time, nullable: true }
 *         createdAt: { type: string, format: date-time }
 */

/**
 * @swagger
 * /notifications:
 *   get:
 *     summary: Lista as notificações do usuário (mais recentes primeiro, paginação por cursor)
 *     tags: [Notifications]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: query
 *         name: unreadOnly
 *         schema: { type: boolean }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, minimum: 1, maximum: 50, default: 20 }
 *       - in: query
 *         name: cursor
 *         schema: { type: string }
 *         description: Valor de `nextCursor` da página anterior
 *     responses:
 *       200:
 *         description: Página de notificações
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 items:
 *                   type: array
 *                   items: { $ref: '#/components/schemas/Notification' }
 *                 nextCursor: { type: string, nullable: true }
 *                 unreadCount: { type: integer }
 */
router.get("/", wrap(controller.list.bind(controller)));

/**
 * @swagger
 * /notifications/unread-count:
 *   get:
 *     summary: Quantidade de notificações não lidas (para o badge do sino)
 *     tags: [Notifications]
 *     security:
 *       - BearerAuth: []
 *     responses:
 *       200:
 *         description: Contagem
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 count: { type: integer }
 */
router.get("/unread-count", wrap(controller.unreadCount.bind(controller)));

/**
 * @swagger
 * /notifications/read-all:
 *   patch:
 *     summary: Marca todas as notificações do usuário como lidas
 *     tags: [Notifications]
 *     security:
 *       - BearerAuth: []
 *     responses:
 *       200:
 *         description: Quantidade marcada
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 updated: { type: integer }
 */
router.patch("/read-all", wrap(controller.markAllAsRead.bind(controller)));

/**
 * @swagger
 * /notifications/{id}/read:
 *   patch:
 *     summary: Marca uma notificação como lida
 *     tags: [Notifications]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       204: { description: Marcada como lida (idempotente) }
 *       404: { description: Notificação não encontrada ou de outro usuário }
 */
router.patch("/:id/read", wrap(controller.markAsRead.bind(controller)));

export default router;
