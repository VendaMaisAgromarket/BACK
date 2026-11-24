import { Request, Response } from "express";
import { CertificationError, CertificationRequester } from "./certification.errors";
import { HarvestCertificationService } from "./harvestCertification.service";

function requester(req: Request): CertificationRequester {
  if (!req.user?.userId) throw new CertificationError(403, "Token inválido ou ausente.");
  return { userId: req.user.userId, role: req.user.role };
}

function uploadedFiles(req: Request): Express.Multer.File[] {
  return Array.isArray(req.files) ? req.files : [];
}

export class HarvestCertificationController {
  constructor(private readonly service: HarvestCertificationService = new HarvestCertificationService()) {}

  /** POST /certifications/harvest (multipart: campos + `documents`) */
  async create(req: Request, res: Response) {
    res.status(201).json(await this.service.create(requester(req), req.body, uploadedFiles(req)));
  }

  /** PUT /certifications/harvest/:id (multipart; `documents` opcional) */
  async resubmit(req: Request, res: Response) {
    res.json(await this.service.resubmit(requester(req), String(req.params.id), req.body, uploadedFiles(req)));
  }

  /** GET /certifications/harvest/mine */
  async listMine(req: Request, res: Response) {
    res.json(await this.service.listMine(requester(req).userId));
  }

  /** GET /certifications/harvest/:id */
  async getById(req: Request, res: Response) {
    res.json(await this.service.getById(requester(req), String(req.params.id)));
  }

  /** GET /certifications/harvest/:id/documents/:documentId/url */
  async getDocumentUrl(req: Request, res: Response) {
    res.json(await this.service.getDocumentUrl(requester(req), String(req.params.id), String(req.params.documentId)));
  }

  /** GET /certifications/harvest/product/:productId/badge */
  async getProductBadge(req: Request, res: Response) {
    res.json(await this.service.getProductBadge(String(req.params.productId)));
  }

  /** PUT /certifications/harvest/:id/products/:productId */
  async linkProduct(req: Request, res: Response) {
    res.json(await this.service.linkProduct(requester(req), String(req.params.id), String(req.params.productId)));
  }

  /** DELETE /certifications/harvest/:id/products/:productId */
  async unlinkProduct(req: Request, res: Response) {
    await this.service.unlinkProduct(requester(req), String(req.params.id), String(req.params.productId));
    res.status(204).send();
  }

  /** GET /certifications/harvest/admin?status=&type=&userId=&limit=&cursor= */
  async listForAdmin(req: Request, res: Response) {
    res.json(await this.service.listForAdmin(req.query));
  }

  /** GET /certifications/harvest/admin/history?action=&certificationId=&actorId=&from=&to=&limit=&cursor= */
  async listHistory(req: Request, res: Response) {
    res.json(await this.service.listHistory(req.query));
  }

  /** PATCH /certifications/harvest/admin/:id/approve */
  async approve(req: Request, res: Response) {
    res.json(await this.service.approve(requester(req), String(req.params.id), req.body));
  }

  /** PATCH /certifications/harvest/admin/:id/reject */
  async reject(req: Request, res: Response) {
    res.json(await this.service.reject(requester(req), String(req.params.id), req.body));
  }

  /** PATCH /certifications/harvest/admin/:id/revoke */
  async revoke(req: Request, res: Response) {
    res.json(await this.service.revoke(requester(req), String(req.params.id), req.body));
  }
}
