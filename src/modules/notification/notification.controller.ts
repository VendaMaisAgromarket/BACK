import { Request, Response } from "express";
import { NotificationService } from "./notification.service";

const service = new NotificationService();

function requireUserId(req: Request, res: Response): string | null {
  const userId = req.user?.userId;
  if (!userId) {
    res.status(401).json({ error: "Token inválido ou ausente." });
    return null;
  }
  return userId;
}

export class NotificationController {
  /** GET /notifications?unreadOnly=true&limit=20&cursor=<id> */
  async list(req: Request, res: Response) {
    const userId = requireUserId(req, res);
    if (!userId) return;

    const limitRaw = req.query.limit !== undefined ? Number(req.query.limit) : undefined;
    if (limitRaw !== undefined && (!Number.isInteger(limitRaw) || limitRaw < 1)) {
      res.status(400).json({ error: "limit deve ser um inteiro positivo." });
      return;
    }

    const result = await service.list(userId, {
      unreadOnly: req.query.unreadOnly === "true",
      limit: limitRaw,
      cursor: typeof req.query.cursor === "string" && req.query.cursor ? req.query.cursor : undefined,
    });
    res.json(result);
  }

  /** GET /notifications/unread-count */
  async unreadCount(req: Request, res: Response) {
    const userId = requireUserId(req, res);
    if (!userId) return;

    res.json({ count: await service.unreadCount(userId) });
  }

  /** PATCH /notifications/:id/read */
  async markAsRead(req: Request, res: Response) {
    const userId = requireUserId(req, res);
    if (!userId) return;

    const found = await service.markAsRead(userId, String(req.params.id));
    if (!found) {
      res.status(404).json({ error: "Notificação não encontrada." });
      return;
    }
    res.status(204).send();
  }

  /** PATCH /notifications/read-all */
  async markAllAsRead(req: Request, res: Response) {
    const userId = requireUserId(req, res);
    if (!userId) return;

    res.json({ updated: await service.markAllAsRead(userId) });
  }
}
