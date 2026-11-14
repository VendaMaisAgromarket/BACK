import { Router, Request, Response, NextFunction, RequestHandler } from "express";
import multer from "multer";
import { protectRoute, requireAdmin } from "../../middlewares/auth.middleware";
import { CertificationError } from "./certification.errors";
import { FarmCertificationController } from "./farmCertification.controller";
import { MAX_FILES_PER_UPLOAD } from "./farmCertification.service";

const router = Router();
const controller = new FarmCertificationController();

const wrap =
  (fn: (req: Request, res: Response) => Promise<unknown> | void) =>
    (req: Request, res: Response, next: NextFunction) =>
      Promise.resolve(fn(req, res)).catch(next);

const ALLOWED_MIME_TYPES = ["application/pdf", "image/jpeg", "image/png", "image/webp"];
const MAX_FILE_SIZE_MB = 10;

const multerDocuments = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_SIZE_MB * 1024 * 1024, files: MAX_FILES_PER_UPLOAD },
  fileFilter: (_req, file, cb) => {
    if (ALLOWED_MIME_TYPES.includes(file.mimetype)) cb(null, true);
    else cb(new CertificationError(400, "Formato não permitido: envie PDF, JPG, PNG ou WEBP."));
  },
}).array("documents", MAX_FILES_PER_UPLOAD);

/** Erros do multer (arquivo grande demais, arquivos demais) viram 400 em vez de 500. */
const uploadDocuments: RequestHandler = (req, res, next) =>
  multerDocuments(req, res, (err?: unknown) => {
    if (err instanceof multer.MulterError) {
      // LIMIT_UNEXPECTED_FILE também é o que o multer devolve quando passa do limite no campo certo.
      const unexpectedField = err.code === "LIMIT_UNEXPECTED_FILE" && err.field && err.field !== "documents";
      const message =
        err.code === "LIMIT_FILE_SIZE"
          ? `Cada arquivo pode ter no máximo ${MAX_FILE_SIZE_MB} MB.`
          : unexpectedField
            ? `Campo de arquivo "${err.field}" não reconhecido: envie os arquivos no campo "documents".`
            : err.code === "LIMIT_FILE_COUNT" || err.code === "LIMIT_UNEXPECTED_FILE"
              ? `Envie no máximo ${MAX_FILES_PER_UPLOAD} arquivos por vez.`
              : "Falha no envio dos arquivos.";
      return next(new CertificationError(400, message));
    }
    next(err);
  });

/**
 * @swagger
 * tags:
 *   - name: FarmCertification
 *     description: Certificação de fazenda (selo de produtor certificado)
 */

/**
 * @swagger
 * /certifications/farm/badge/{userId}:
 *   get:
 *     summary: Selo público de fazenda certificada de um produtor (só dados não sensíveis)
 *     tags: [FarmCertification]
 *     parameters:
 *       - in: path
 *         name: userId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: "{ userId, certified, certifications: [{ id, type, certifierName, certificateNumber, city, uf, validUntil }] }"
 */
router.get("/badge/:userId", wrap(controller.getBadge.bind(controller)));

router.use(protectRoute as RequestHandler);

// ─── Admin ─────────────────────────────────────────────────────────────────────

/**
 * @swagger
 * /certifications/farm/admin:
 *   get:
 *     summary: Fila de certificações de fazenda para avaliação (admin)
 *     tags: [FarmCertification]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: query
 *         name: status
 *         schema: { type: string, enum: [PENDING, APPROVED, REJECTED, EXPIRED, REVOKED], default: PENDING }
 *       - in: query
 *         name: type
 *         schema: { type: string, enum: [ORGANIC_SISORG, GLOBALGAP, RAINFOREST_ALLIANCE, FAIR_TRADE, OTHER] }
 *       - in: query
 *         name: userId
 *         schema: { type: string }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, minimum: 1, maximum: 50, default: 20 }
 *       - in: query
 *         name: cursor
 *         schema: { type: string }
 *     responses:
 *       200: { description: "{ items, nextCursor }" }
 *       403: { description: Apenas admin }
 */
router.get("/admin", requireAdmin, wrap(controller.listForAdmin.bind(controller)));

/**
 * @swagger
 * /certifications/farm/admin/{id}/approve:
 *   patch:
 *     summary: Aprova uma certificação pendente (ativa o selo)
 *     tags: [FarmCertification]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string } }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [revision]
 *             properties:
 *               revision: { type: integer, description: "Campo `revision` do detalhe que o admin analisou" }
 *               documentId: { type: string, description: "Documento que embasou a aprovação (padrão: certificado mais recente)" }
 *               notes: { type: string }
 *     responses:
 *       200: { description: Certificação atualizada, com histórico }
 *       409: { description: "Não está pendente, o certificado já venceu, ou o produtor reenviou depois (revision desatualizada)" }
 */
router.patch("/admin/:id/approve", requireAdmin, wrap(controller.approve.bind(controller)));

/**
 * @swagger
 * /certifications/farm/admin/{id}/reject:
 *   patch:
 *     summary: Recusa uma certificação pendente (o produtor pode corrigir e reenviar)
 *     tags: [FarmCertification]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string } }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [revision, reason]
 *             properties:
 *               revision: { type: integer, description: "Campo `revision` do detalhe que o admin analisou" }
 *               reason: { type: string }
 *               notes: { type: string }
 *     responses:
 *       200: { description: Certificação atualizada }
 *       409: { description: "Não está pendente, ou revision desatualizada" }
 */
router.patch("/admin/:id/reject", requireAdmin, wrap(controller.reject.bind(controller)));

/**
 * @swagger
 * /certifications/farm/admin/{id}/revoke:
 *   patch:
 *     summary: Revoga uma certificação aprovada (remove o selo)
 *     tags: [FarmCertification]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string } }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [reason]
 *             properties:
 *               revision: { type: integer, description: "Opcional: se enviado, precisa ser o atual" }
 *               reason: { type: string }
 *               notes: { type: string }
 *     responses:
 *       200: { description: Certificação atualizada }
 *       409: { description: Não está aprovada }
 */
router.patch("/admin/:id/revoke", requireAdmin, wrap(controller.revoke.bind(controller)));

// ─── Produtor ──────────────────────────────────────────────────────────────────

/**
 * @swagger
 * /certifications/farm:
 *   post:
 *     summary: Produtor envia a certificação da fazenda para avaliação
 *     tags: [FarmCertification]
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             required: [farmName, city, uf, areaHectares, type, certifierName, certifierCnpj, certificateNumber, issuedAt, validUntil, documents]
 *             properties:
 *               farmName: { type: string }
 *               city: { type: string }
 *               uf: { type: string, example: MG }
 *               ccir: { type: string, description: "CCIR e/ou CAR (ao menos um)" }
 *               car: { type: string }
 *               areaHectares: { type: number, example: 12.5 }
 *               type: { type: string, enum: [ORGANIC_SISORG, GLOBALGAP, RAINFOREST_ALLIANCE, FAIR_TRADE, OTHER] }
 *               certifierName: { type: string }
 *               certifierCnpj: { type: string }
 *               certificateNumber: { type: string }
 *               issuedAt: { type: string, format: date, example: "2026-03-01" }
 *               validUntil: { type: string, format: date, example: "2027-03-01" }
 *               documents:
 *                 type: array
 *                 items: { type: string, format: binary }
 *                 description: "1 a 5 arquivos (PDF/JPG/PNG/WEBP, até 10 MB cada)"
 *               documentTypes:
 *                 type: array
 *                 items: { type: string, enum: [CERTIFICATE, AUDIT_REPORT, OTHER] }
 *                 description: "Tipo de cada arquivo, na mesma ordem (padrão: CERTIFICATE)"
 *     responses:
 *       201: { description: Certificação criada como PENDING }
 *       400: { description: Dados ou arquivos inválidos }
 *       403: { description: Usuário não é produtor }
 *       409: { description: Certificado já pendente ou aprovado }
 */
router.post("/", uploadDocuments, wrap(controller.create.bind(controller)));

/**
 * @swagger
 * /certifications/farm/mine:
 *   get:
 *     summary: Certificações de fazenda do produtor logado (com `badgeActive`)
 *     tags: [FarmCertification]
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: Lista de certificações com documentos }
 */
router.get("/mine", wrap(controller.listMine.bind(controller)));

/**
 * @swagger
 * /certifications/farm/{id}:
 *   get:
 *     summary: Detalhe com documentos e histórico (dono ou admin)
 *     tags: [FarmCertification]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string } }
 *     responses:
 *       200: { description: Certificação; para admin inclui `user` com os dados do produtor }
 *       404: { description: Não encontrada }
 *   put:
 *     summary: Corrige e reenvia uma certificação pendente ou recusada (volta a PENDING)
 *     tags: [FarmCertification]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string } }
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             description: "Mesmos campos do POST; `documents` é opcional (novos arquivos são anexados aos existentes)"
 *     responses:
 *       200: { description: Certificação reenviada }
 *       409: { description: Status não permite edição }
 */
router.get("/:id", wrap(controller.getById.bind(controller)));
router.put("/:id", uploadDocuments, wrap(controller.resubmit.bind(controller)));

/**
 * @swagger
 * /certifications/farm/{id}/documents/{documentId}/url:
 *   get:
 *     summary: URL temporária (10 min) para visualizar/baixar um documento (dono ou admin)
 *     tags: [FarmCertification]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string } }
 *       - { in: path, name: documentId, required: true, schema: { type: string } }
 *     responses:
 *       200: { description: "{ url, expiresIn, originalName, mimeType }" }
 *       404: { description: Não encontrado }
 */
router.get("/:id/documents/:documentId/url", wrap(controller.getDocumentUrl.bind(controller)));

export default router;
