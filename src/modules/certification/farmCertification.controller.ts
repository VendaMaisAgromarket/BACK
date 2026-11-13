import { Request, Response } from "express";
import { CertificationError, CertificationRequester } from "./certification.errors";
import { FarmCertificationService } from "./farmCertification.service";

function requester(req: Request): CertificationRequester {
  if (!req.user?.userId) throw new CertificationError(403, "Token inválido ou ausente.");
  return { userId: req.user.userId, role: req.user.role };
}

function uploadedFiles(req: Request): Express.Multer.File[] {
  return Array.isArray(req.files) ? req.files : [];
}

export class FarmCertificationController {
  constructor(private readonly service: FarmCertificationService = new FarmCertificationService()) {}

  /** POST /certifications/farm (multipart: campos + `documents`) */
  async create(req: Request, res: Response) {
    res.status(201).json(await this.service.create(requester(req), req.body, uploadedFiles(req)));
  }

  /** PUT /certifications/farm/:id (multipart; `documents` opcional) */
  async resubmit(req: Request, res: Response) {
    res.json(await this.service.resubmit(requester(req), String(req.params.id), req.body, uploadedFiles(req)));
  }

  /** GET /certifications/farm/mine */
  async listMine(req: Request, res: Response) {
    res.json(await this.service.listMine(requester(req).userId));
  }

  /** GET /certifications/farm/:id */
  async getById(req: Request, res: Response) {
    res.json(await this.service.getById(requester(req), String(req.params.id)));
  }

  /** GET /certifications/farm/:id/documents/:documentId/url */
  async getDocumentUrl(req: Request, res: Response) {
    res.json(await this.service.getDocumentUrl(requester(req), String(req.params.id), String(req.params.documentId)));
  }

  /** GET /certifications/farm/badge/:userId */
  async getBadge(req: Request, res: Response) {
    res.json(await this.service.getBadge(String(req.params.userId)));
  }

  /** GET /certifications/farm/admin?status=&type=&userId=&limit=&cursor= */
  async listForAdmin(req: Request, res: Response) {
    res.json(await this.service.listForAdmin(req.query));
  }

  /** PATCH /certifications/farm/admin/:id/approve */
  async approve(req: Request, res: Response) {
    res.json(await this.service.approve(requester(req), String(req.params.id), req.body));
  }

  /** PATCH /certifications/farm/admin/:id/reject */
  async reject(req: Request, res: Response) {
    res.json(await this.service.reject(requester(req), String(req.params.id), req.body));
  }

  /** PATCH /certifications/farm/admin/:id/revoke */
  async revoke(req: Request, res: Response) {
    res.json(await this.service.revoke(requester(req), String(req.params.id), req.body));
  }
}
